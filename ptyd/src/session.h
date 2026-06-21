#pragma once
#include <string>
#include <vector>
#include <functional>
#include <chrono>
#include <regex>
#include <uv.h>
#include <sys/types.h>
#include <unordered_map>
#include <memory>

struct Session {
  std::string id;
  pid_t pid = -1;
  int masterFd = -1;
  std::string slavePath;
  int cols = 80;
  int rows = 24;
  bool alive = false;
  bool busy = false;

  // Output buffer — raw bytes from master FD
  std::string buffer;
  int64_t totalBytesEmitted = 0;

  // Rolling history (ANSI-stripped lines)
  std::vector<std::string> history;
  int64_t historyTotalLines = 0;
  static constexpr size_t HISTORY_MAX_LINES = 10000;
  static constexpr size_t MAX_BUFFER_BYTES = 1024 * 1024; // 1MB

  // Timestamps
  std::chrono::steady_clock::time_point createdAt;
  std::chrono::steady_clock::time_point lastActivity;

  // Callback for output events
  std::function<void(const std::string& sessionId, const std::string& data, int64_t bytesEmitted)> onOutput;
  std::function<void(const std::string& sessionId, int exitCode)> onExit;

  // libuv poll handle for master FD
  uv_poll_t pollHandle;

  // Pending marker for exec detection
  std::string pendingMarker;
};

class SessionManager {
public:
  SessionManager(size_t maxSessions = 10);

  // Create a new PTY session
  Session* create(const std::string& id, const std::string& shell,
                   const std::vector<std::string>& shellArgs,
                   int cols, int rows, const std::string& cwd,
                   const std::string& name,
                   const std::vector<std::pair<std::string,std::string>>& env,
                   uv_loop_t* loop);

  Session* get(const std::string& id);
  void remove(const std::string& id);
  std::vector<Session*> list();
  void removeAll();

  size_t maxSessions() const { return maxSessions_; }

private:
  std::unordered_map<std::string, std::unique_ptr<Session>> sessions_;
  size_t maxSessions_;

  // Start reading from master FD
  void startMasterRead(Session* session, uv_loop_t* loop);

  // Handle data from master FD
  void handleMasterData(Session* session, const char* data, size_t len);
};
