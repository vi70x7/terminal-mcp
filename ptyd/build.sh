#!/bin/bash
set -e
cd "$(dirname "$0")"
mkdir -p build
g++ -O2 -Wall -std=c++17 \
  -Ivendor \
  $(pkg-config --cflags libuv) \
  -Isrc \
  src/main.cpp src/session.cpp src/server.cpp \
  $(pkg-config --libs libuv) -lutil \
  -o build/ptyd
echo "Build succeeded: $(pwd)/build/ptyd"
