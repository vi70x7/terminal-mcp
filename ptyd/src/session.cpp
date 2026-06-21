#include "session.h"
#include <pty.h>
#include <unistd.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
#include <signal.h>
#include <uv.h>
#include <algorithm>
#include <cstring>
#include <cstdlib>

// Minimal ANSI stripping for history
static std::string stripAnsi(const std::string& input) {
  static const std::regex ansi_regex(
    "\x1b\\[[0-9;]*[a-zA-Z]|"   // CSI sequences
    "\x1b\\][^\x07]*\x07|"      // OSC sequences
    "\x1b[()][AB012]|"          // Character set
    "\r"                        // Carriage return
  );
  return std::regex_replace(input, ansi_regex, "");
}

SessionManager::SessionManager(size_t maxSessions)
  : maxSessions_(maxSessions) {}

Session* SessionManager::create(const std::string& id,
                                 const std::string& shell,
                                 const std::vector<std::string>& shellArgs,
                                 int cols, int rows,
                                 const std::string& cwd,
                                 const std::string& /*name*/,
                                 const std::vector<std::pair<std::string,std::string>>& env,
                                 uv_loop_t* loop) {
  if (sessions_.count(id)) return nullptr;
  if (sessions_.size() >= maxSessions_) return nullptr;

  // Build argv: shell + shellArgs
  std::vector<char*> argv;
  std::vector<std::string> argvStorage;
  argvStorage.push_back(shell);
  for (const auto& arg : shellArgs) argvStorage.push_back(arg);
  for (auto& s : argvStorage) argv.push_back(s.data());
  argv.push_back(nullptr);

  int masterFd = -1;
  pid_t pid = forkpty(&masterFd, nullptr, nullptr, nullptr);

  if (pid < 0) {
    return nullptr;
  }

  if (pid == 0) {
    // Child process
    // Set terminal size
    struct winsize ws;
    ws.ws_col = cols;
    ws.ws_row = rows;
    ws.ws_xpixel = 0;
    ws.ws_ypixel = 0;
    ioctl(0, TIOCSWINSZ, &ws);

    // Change working directory
    if (!cwd.empty()) {
      if (chdir(cwd.c_str()) != 0) {
        perror("chdir");
      }
    }

    // Set environment
    for (const auto& [key, val] : env) {
      setenv(key.c_str(), val.c_str(), 1);
    }

    // Set process group
    setpgid(0, 0);

    // Set TERM
    setenv("TERM", "xterm-256color", 1);

    // Exec the shell
    execvp(shell.c_str(), argv.data());
    perror("execvp");
    _exit(127);
  }

  // Parent
  auto session = std::make_unique<Session>();
  session->id = id;
  session->pid = pid;
  session->masterFd = masterFd;
  session->cols = cols;
  session->rows = rows;
  session->alive = true;
  session->createdAt = std::chrono::steady_clock::now();
  session->lastActivity = session->createdAt;

  // Get slave path
  char slaveName[256];
  if (ptsname_r(masterFd, slaveName, sizeof(slaveName)) == 0) {
    session->slavePath = slaveName;
  }

  auto* raw = session.get();
  sessions_[id] = std::move(session);

  startMasterRead(raw, loop);

  return raw;
}

void SessionManager::startMasterRead(Session* session, uv_loop_t* loop) {
  uv_poll_init(loop, &session->pollHandle, session->masterFd);
  session->pollHandle.data = session;

  uv_poll_start(&session->pollHandle, UV_READABLE,
    [](uv_poll_t* handle, int status, int events) {
      (void)events;
      auto* s = static_cast<Session*>(handle->data);
      if (status < 0) return;

      char buf[65536];
      ssize_t n;
      while ((n = read(s->masterFd, buf, sizeof(buf))) > 0) {
        s->buffer.append(buf, n);
        s->totalBytesEmitted += n;
        s->lastActivity = std::chrono::steady_clock::now();

        // Trim buffer if too large
        if (s->buffer.size() > Session::MAX_BUFFER_BYTES) {
          size_t excess = s->buffer.size() - Session::MAX_BUFFER_BYTES;
          s->buffer.erase(0, excess);
        }

        // Strip ANSI, split into lines, append to history
        std::string cleaned = stripAnsi(std::string(buf, n));
        size_t pos = 0;
        while (pos < cleaned.size()) {
          size_t nl = cleaned.find('\n', pos);
          if (nl == std::string::npos) {
            // Partial line — append to last history entry or start new one
            if (!s->history.empty()) {
              s->history.back() += cleaned.substr(pos);
            } else {
              s->history.push_back(cleaned.substr(pos));
            }
            break;
          }
          std::string line = cleaned.substr(pos, nl - pos);
          // Remove trailing \r if present
          if (!line.empty() && line.back() == '\r') line.pop_back();
          s->history.push_back(line);
          s->historyTotalLines++;
          pos = nl + 1;
        }

        // Evict old history lines
        while (s->history.size() > Session::HISTORY_MAX_LINES) {
          s->history.erase(s->history.begin());
        }

        // Fire callback
        if (s->onOutput) {
          s->onOutput(s->id, std::string(buf, n), s->totalBytesEmitted);
        }
      }

      // If read returns 0 or error (EIO = child exited), mark dead
      if (n <= 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
        s->alive = false;
        uv_poll_stop(handle);
        close(s->masterFd);
        s->masterFd = -1;
      }
    });
}

void SessionManager::handleMasterData(Session* session, const char* data, size_t len) {
  (void)session;
  (void)data;
  (void)len;
}

Session* SessionManager::get(const std::string& id) {
  auto it = sessions_.find(id);
  return it != sessions_.end() ? it->second.get() : nullptr;
}

void SessionManager::remove(const std::string& id) {
  auto it = sessions_.find(id);
  if (it == sessions_.end()) return;

  auto* s = it->second.get();

  // Stop polling
  uv_poll_stop(&s->pollHandle);

  // Close master FD (sends SIGHUP to child's controlling terminal)
  if (s->masterFd >= 0) {
    close(s->masterFd);
    s->masterFd = -1;
  }

  // Kill the process group
  if (s->pid > 0) {
    // Kill the process group (PGID = child PID since we setpgid(0,0))
    killpg(s->pid, SIGTERM);

    // Brief wait then SIGKILL
    for (int i = 0; i < 10; i++) {
      int status;
      pid_t ret = waitpid(s->pid, &status, WNOHANG);
      if (ret == s->pid) break;
      if (ret < 0 && errno == ECHILD) break;
      usleep(50000); // 50ms
    }

    // Force kill
    killpg(s->pid, SIGKILL);
    waitpid(s->pid, nullptr, WNOHANG);
  }

  sessions_.erase(it);
}

std::vector<Session*> SessionManager::list() {
  std::vector<Session*> result;
  for (auto& [_, s] : sessions_) {
    result.push_back(s.get());
  }
  return result;
}

void SessionManager::removeAll() {
  auto ids = std::vector<std::string>();
  for (auto& [id, _] : sessions_) ids.push_back(id);
  for (const auto& id : ids) remove(id);
}
