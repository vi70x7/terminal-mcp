CXX = g++
CXXFLAGS = -O2 -Wall -std=c++17
INCLUDES = -Ivendor $(shell pkg-config --cflags libuv) -Isrc
LIBS = $(shell pkg-config --libs libuv) -lutil

SRCS = src/main.cpp src/session.cpp src/server.cpp
TARGET = build/ptyd

all: $(TARGET)

$(TARGET): $(SRCS) src/*.h vendor/nlohmann/json.hpp
	mkdir -p build
	$(CXX) $(CXXFLAGS) $(INCLUDES) $(SRCS) $(LIBS) -o $(TARGET)

clean:
	rm -rf build

.PHONY: all clean
