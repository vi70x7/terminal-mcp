cmake_minimum_required(VERSION 3.16)
project(ptyd VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBUV REQUIRED libuv)

add_executable(ptyd
  src/main.cpp
  src/session.cpp
  src/server.cpp
)

target_include_directories(ptyd PRIVATE
  ${LIBUV_INCLUDE_DIRS}
  vendor
  src
)

target_link_libraries(ptyd PRIVATE
  ${LIBUV_LIBRARIES}
  util
)

target_compile_options(ptyd PRIVATE -Wall -Wextra -O2)
