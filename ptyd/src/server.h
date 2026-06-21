#pragma once
#include <string>
#include <vector>
#include <unordered_map>
#include <functional>
#include "session.h"
#include <nlohmann/json.hpp>

class Server {
public:
  Server(uv_loop_t* loop, const std::string& socketPath, SessionManager& sm);
  ~Server();

  void start();
  void stop();

  // Send a JSON response or event to all connected clients
  void broadcast(const std::string& json);

private:
  uv_loop_t* loop_;
  std::string socketPath_;
  SessionManager& sessionManager_;

  uv_pipe_t serverHandle_;
  std::vector<uv_stream_t*> clients_;

  void onConnection(uv_stream_t* server, int status);
  void onData(uv_stream_t* client, ssize_t nread, const uv_buf_t* buf);
  void onSessionOutput(const std::string& sessionId, const std::string& data, int64_t bytesEmitted);
  void onSessionExit(const std::string& sessionId, int exitCode);

  // JSON dispatch
  std::string dispatch(const std::string& json);

  // Method handlers
  nlohmann::json handleStart(const nlohmann::json& params);
  nlohmann::json handleWrite(const nlohmann::json& params);
  nlohmann::json handleResize(const nlohmann::json& params);
  nlohmann::json handleKill(const nlohmann::json& params);
  nlohmann::json handleSignal(const nlohmann::json& params);
  nlohmann::json handleList();
  nlohmann::json handleShutdown();
};
