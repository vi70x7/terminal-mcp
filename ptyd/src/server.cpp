#include "server.h"
#include <uv.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <cstring>
#include <algorithm>
#include <signal.h>

using json = nlohmann::json;

// Per-client write buffer for outgoing data
struct ClientWrite {
  uv_write_t req;
  uv_buf_t buf;
};

Server::Server(uv_loop_t* loop, const std::string& socketPath, SessionManager& sm)
  : loop_(loop), socketPath_(socketPath), sessionManager_(sm) {}

Server::~Server() {
  stop();
}

void Server::start() {
  // Remove stale socket
  struct stat st;
  if (stat(socketPath_.c_str(), &st) == 0) {
    unlink(socketPath_.c_str());
  }

  uv_pipe_init(loop_, &serverHandle_, 0);
  serverHandle_.data = this;

  int r = uv_pipe_bind(&serverHandle_, socketPath_.c_str());
  if (r < 0) {
    fprintf(stderr, "[ptyd] bind error: %s\n", uv_strerror(r));
    return;
  }

  r = uv_listen(reinterpret_cast<uv_stream_t*>(&serverHandle_), 128,
    [](uv_stream_t* server, int status) {
      auto* self = static_cast<Server*>(server->data);
      self->onConnection(server, status);
    });

  if (r < 0) {
    fprintf(stderr, "[ptyd] listen error: %s\n", uv_strerror(r));
    return;
  }
}

void Server::stop() {
  // Close client handles (guard against already-closing handles)
  for (auto* client : clients_) {
    if (!uv_is_closing(reinterpret_cast<uv_handle_t*>(client))) {
      uv_close(reinterpret_cast<uv_handle_t*>(client), [](uv_handle_t* h) {
        free(h);
      });
    }
  }
  clients_.clear();

  if (!uv_is_closing(reinterpret_cast<uv_handle_t*>(&serverHandle_))) {
    uv_close(reinterpret_cast<uv_handle_t*>(&serverHandle_), nullptr);
  }

  // Remove socket file
  unlink(socketPath_.c_str());

  sessionManager_.removeAll();
}

void Server::broadcast(const std::string& jsonStr) {
  if (clients_.empty()) return;

  for (auto* client : clients_) {
    auto* w = new ClientWrite;
    w->buf = uv_buf_init(strdup(jsonStr.c_str()), jsonStr.size());
    w->req.data = w;
    uv_write(&w->req, client, &w->buf, 1,
      [](uv_write_t* req, int status) {
        auto* w = static_cast<ClientWrite*>(req->data);
        free(w->buf.base);
        delete w;
        (void)status;
      });
  }
}

void Server::onConnection(uv_stream_t* server, int status) {
  if (status < 0) return;

  auto* client = static_cast<uv_stream_t*>(malloc(sizeof(uv_pipe_t)));
  uv_pipe_init(loop_, reinterpret_cast<uv_pipe_t*>(client), 0);
  client->data = this;

  int r = uv_accept(server, client);
  if (r < 0) {
    uv_close(reinterpret_cast<uv_handle_t*>(client), [](uv_handle_t* h) { free(h); });
    return;
  }

  clients_.push_back(client);

  // Start reading
  uv_read_start(client,
    [](uv_handle_t* /*handle*/, size_t suggested_size, uv_buf_t* buf) {
      buf->base = static_cast<char*>(malloc(suggested_size));
      buf->len = suggested_size;
    },
    [](uv_stream_t* stream, ssize_t nread, const uv_buf_t* buf) {
      auto* self = static_cast<Server*>(stream->data);
      self->onData(stream, nread, buf);
    });
}

void Server::onData(uv_stream_t* client, ssize_t nread, const uv_buf_t* buf) {
  if (nread <= 0) {
    if (nread < 0) {
      // Client disconnected
      auto it = std::find(clients_.begin(), clients_.end(), client);
      if (it != clients_.end()) clients_.erase(it);
      if (!uv_is_closing(reinterpret_cast<uv_handle_t*>(client))) {
        uv_close(reinterpret_cast<uv_handle_t*>(client), [](uv_handle_t* h) { free(h); });
      }
    }
    free(buf->base);
    return;
  }

  std::string input(buf->base, nread);
  free(buf->base);

  // Dispatch and send response
  std::string response = dispatch(input);
  if (!response.empty()) {
    auto* w = new ClientWrite;
    w->buf = uv_buf_init(strdup(response.c_str()), response.size());
    w->req.data = w;
    uv_write(&w->req, client, &w->buf, 1,
      [](uv_write_t* req, int status) {
        auto* w = static_cast<ClientWrite*>(req->data);
        free(w->buf.base);
        delete w;
        (void)status;
      });
  }
}

void Server::onSessionOutput(const std::string& sessionId, const std::string& data, int64_t bytesEmitted) {
  json evt;
  evt["type"] = "output";
  evt["sessionId"] = sessionId;
  // Base64-encode the raw data to be JSON-safe
  static const char b64table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string encoded;
  encoded.reserve(((data.size() + 2) / 3) * 4);
  for (size_t i = 0; i < data.size(); i += 3) {
    unsigned int n = (unsigned char)data[i] << 16;
    if (i + 1 < data.size()) n |= (unsigned char)data[i+1] << 8;
    if (i + 2 < data.size()) n |= (unsigned char)data[i+2];
    encoded.push_back(b64table[(n >> 18) & 0x3F]);
    encoded.push_back(b64table[(n >> 12) & 0x3F]);
    encoded.push_back((i + 1 < data.size()) ? b64table[(n >> 6) & 0x3F] : '=');
    encoded.push_back((i + 2 < data.size()) ? b64table[n & 0x3F] : '=');
  }
  evt["data"] = encoded;
  evt["bytesEmitted"] = bytesEmitted;
  broadcast(evt.dump() + "\n");
}

void Server::onSessionExit(const std::string& sessionId, int exitCode) {
  json evt;
  evt["type"] = "exit";
  evt["sessionId"] = sessionId;
  evt["exitCode"] = exitCode;
  broadcast(evt.dump() + "\n");
}

std::string Server::dispatch(const std::string& jsonStr) {
  try {
    auto msg = json::parse(jsonStr);
    std::string method = msg.value("method", "");
    auto params = msg.value("params", json::object());
    int id = msg.value("id", -1);

    json result;

    if (method == "start") {
      result = handleStart(params);
    } else if (method == "write") {
      result = handleWrite(params);
    } else if (method == "resize") {
      result = handleResize(params);
    } else if (method == "kill") {
      result = handleKill(params);
    } else if (method == "signal") {
      result = handleSignal(params);
    } else if (method == "list") {
      result = handleList();
    } else if (method == "shutdown") {
      result = handleShutdown();
    } else {
      result = json{{"error", "unknown method: " + method}};
    }

    json resp;
    resp["id"] = id;
    resp["result"] = result;
    return resp.dump() + "\n";

  } catch (const std::exception& e) {
    json resp;
    resp["id"] = -1;
    resp["error"] = e.what();
    return resp.dump() + "\n";
  }
}

nlohmann::json Server::handleStart(const nlohmann::json& params) {
  std::string id = params.value("id", "");
  std::string shell = params.value("shell", "/bin/bash");
  auto shellArgsJson = params.value("shellArgs", json::array());
  std::vector<std::string> shellArgs;
  for (auto& a : shellArgsJson) shellArgs.push_back(a.get<std::string>());
  int cols = params.value("cols", 80);
  int rows = params.value("rows", 24);
  std::string cwd = params.value("cwd", "");
  std::string name = params.value("name", "");

  auto envJson = params.value("env", json::object());
  std::vector<std::pair<std::string,std::string>> env;
  for (auto& [k, v] : envJson.items()) {
    env.emplace_back(k, v.get<std::string>());
  }

  auto* s = sessionManager_.create(id, shell, shellArgs, cols, rows, cwd, name, env, loop_);
  if (!s) {
    return json{{"error", "failed to create session (max sessions or duplicate id)"}};
  }

  // Wire up output/exit callbacks
  s->onOutput = [this](const std::string& sid, const std::string& data, int64_t bytes) {
    onSessionOutput(sid, data, bytes);
  };
  s->onExit = [this](const std::string& sid, int code) {
    onSessionExit(sid, code);
  };

  return json{
    {"id", s->id},
    {"pid", s->pid},
    {"cols", s->cols},
    {"rows", s->rows},
    {"slavePath", s->slavePath},
    {"alive", s->alive}
  };
}

nlohmann::json Server::handleWrite(const nlohmann::json& params) {
  std::string id = params.value("id", "");
  std::string data = params.value("data", "");
  auto* s = sessionManager_.get(id);
  if (!s || !s->alive) {
    return json{{"error", "session not found or dead"}};
  }

  ssize_t n = write(s->masterFd, data.c_str(), data.size());
  return json{{"bytesWritten", n}};
}

nlohmann::json Server::handleResize(const nlohmann::json& params) {
  std::string id = params.value("id", "");
  int cols = params.value("cols", 80);
  int rows = params.value("rows", 24);
  auto* s = sessionManager_.get(id);
  if (!s || !s->alive) {
    return json{{"error", "session not found or dead"}};
  }

  struct winsize ws;
  ws.ws_col = cols;
  ws.ws_row = rows;
  ws.ws_xpixel = 0;
  ws.ws_ypixel = 0;

  int r = ioctl(s->masterFd, TIOCSWINSZ, &ws);
  if (r == 0) {
    s->cols = cols;
    s->rows = rows;
  }

  return json{{"ok", r == 0}};
}

nlohmann::json Server::handleKill(const nlohmann::json& params) {
  std::string id = params.value("id", "");
  if (!sessionManager_.get(id)) {
    return json{{"error", "session not found"}};
  }
  sessionManager_.remove(id);
  return json{{"ok", true}};
}

nlohmann::json Server::handleSignal(const nlohmann::json& params) {
  std::string id = params.value("id", "");
  int sig = params.value("signal", SIGTERM);
  auto* s = sessionManager_.get(id);
  if (!s || !s->alive) {
    return json{{"error", "session not found or dead"}};
  }

  int r = killpg(s->pid, sig);
  return json{{"ok", r == 0}};
}

nlohmann::json Server::handleList() {
  auto sessions = sessionManager_.list();
  json arr = json::array();
  for (auto* s : sessions) {
    arr.push_back(json{
      {"id", s->id},
      {"pid", s->pid},
      {"cols", s->cols},
      {"rows", s->rows},
      {"alive", s->alive},
      {"slavePath", s->slavePath},
      {"totalBytesEmitted", s->totalBytesEmitted},
      {"historyTotalLines", s->historyTotalLines}
    });
  }
  return json{{"sessions", arr}};
}

nlohmann::json Server::handleShutdown() {
  // Schedule stop on next loop iteration
  uv_stop(loop_);
  return json{{"ok", true}};
}
