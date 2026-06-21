#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <sys/wait.h>
#include <signal.h>
#include <unistd.h>
#include <uv.h>
#include "server.h"
#include "session.h"

static SessionManager* g_sessionManager = nullptr;
static Server* g_server = nullptr;

int main(int argc, char* argv[]) {
  std::string socketPath;

  // Parse args: --socket /path/to/socket
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--socket") == 0 && i + 1 < argc) {
      socketPath = argv[++i];
    }
  }

  if (socketPath.empty()) {
    socketPath = "/tmp/ptyd-" + std::to_string(getuid()) + ".sock";
  }

  uv_loop_t* loop = uv_default_loop();

  SessionManager sessionManager(10);
  g_sessionManager = &sessionManager;

  Server server(loop, socketPath, sessionManager);
  g_server = &server;

  // Set up SIGCHLD handler via libuv
  uv_signal_t sigchld;
  uv_signal_init(loop, &sigchld);
  uv_signal_start(&sigchld, [](uv_signal_t* handle, int signum) {
    (void)handle;
    (void)signum;
    // Reap all dead children
    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
      int exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
      if (WIFSIGNALED(status)) {
        exitCode = -WTERMSIG(status);
      }
      if (g_sessionManager) {
        for (auto* s : g_sessionManager->list()) {
          if (s->pid == pid) {
            s->alive = false;
            if (s->onExit) s->onExit(s->id, exitCode);
            break;
          }
        }
      }
    }
  }, SIGCHLD);

  server.start();
  fprintf(stderr, "[ptyd] Listening on %s\n", socketPath.c_str());

  uv_run(loop, UV_RUN_DEFAULT);

  server.stop();

  // Close signal handle (guard against already-closing)
  if (!uv_is_closing(reinterpret_cast<uv_handle_t*>(&sigchld))) {
    uv_close(reinterpret_cast<uv_handle_t*>(&sigchld), nullptr);
  }

  // Run once more to close handles
  uv_run(loop, UV_RUN_NOWAIT);
  uv_loop_close(loop);

  return 0;
}
