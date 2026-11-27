# Build image for the node host (x86_64 Linux). The service is never compiled
# on the node host itself: a Rust release build would take the node's cores.
# Packages follow the execution-event SDK's requirements (C23 needs clang-19,
# bindgen needs libclang 19, CMake builds libmonad_event.a).
FROM --platform=linux/amd64 ubuntu:24.04
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git gcc g++ make cmake pkg-config \
      clang-19 libclang-19-dev llvm-19-dev libzstd-dev libhugetlbfs-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/root/.cargo/bin:$PATH \
    CC=clang-19 CXX=clang++-19 \
    LLVM_CONFIG_PATH=/usr/lib/llvm-19/bin/llvm-config \
    LIBCLANG_PATH=/usr/lib/llvm-19/lib \
    CARGO_NET_GIT_FETCH_WITH_CLI=true \
    CARGO_TARGET_DIR=/target
