#!/bin/sh
set -eu

edge_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
edge_build=${1:-"$edge_root/build/native"}
edge_cxx=${CXX:-clang++}
mkdir -p "$edge_build"

"$edge_cxx" -std=c++17 -Wall -Wextra -Werror -pedantic -fno-exceptions -fno-rtti \
  -I"$edge_root/include" -c "$edge_root/src/edge_controller.cpp" -o "$edge_build/edge_controller.o"
"$edge_cxx" -std=c++17 -Wall -Wextra -Werror -pedantic -I"$edge_root/include" \
  "$edge_root/tests/controller_test.cpp" "$edge_build/edge_controller.o" -o "$edge_build/baoyan_edge_tests"
"$edge_cxx" -std=c++17 -Wall -Wextra -Werror -pedantic -I"$edge_root/include" \
  "$edge_root/examples/native_demo.cpp" "$edge_build/edge_controller.o" -o "$edge_build/baoyan_edge_demo"

"$edge_build/baoyan_edge_tests"
"$edge_build/baoyan_edge_demo" > "$edge_build/simulation.jsonl"
printf 'Simulation trace: %s\n' "$edge_build/simulation.jsonl"
