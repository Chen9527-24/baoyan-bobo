cmake_minimum_required(VERSION 3.16)
project(baoyan_edge LANGUAGES CXX)

add_library(baoyan_edge STATIC src/edge_controller.cpp)
target_include_directories(baoyan_edge PUBLIC include)
target_compile_features(baoyan_edge PUBLIC cxx_std_17)
set_target_properties(baoyan_edge PROPERTIES CXX_EXTENSIONS OFF)

if(CMAKE_CXX_COMPILER_ID MATCHES "Clang|GNU")
  target_compile_options(baoyan_edge PRIVATE -Wall -Wextra -Werror -pedantic -fno-exceptions -fno-rtti)
endif()

add_executable(baoyan_edge_demo examples/native_demo.cpp)
target_link_libraries(baoyan_edge_demo PRIVATE baoyan_edge)

include(CTest)
if(BUILD_TESTING)
  add_executable(baoyan_edge_tests tests/controller_test.cpp)
  target_link_libraries(baoyan_edge_tests PRIVATE baoyan_edge)
  add_test(NAME edge_controller_contracts COMMAND baoyan_edge_tests)
endif()
