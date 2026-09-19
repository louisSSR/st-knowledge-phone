# OpenZIM javascript-libzim

The unmodified `libzim-wasm.js` and `libzim-wasm.wasm` in this directory are
the production files from the official **v0.95** release of
[OpenZIM javascript-libzim](https://github.com/openzim/javascript-libzim).
Copyright belongs to the OpenZIM/libzim and linked-library contributors.
Licensed under **GPL-3.0-or-later**; the full license is in `LICENSE-GPL-3.0.txt`.
`bridge.js` is this application's GPL-3.0-or-later adapter, not an upstream file.

- Source tag: `v0.95`, commit `470b36920fba421a4c1a83b326e66d8aa0533870`.
- [Corresponding source and build recipe](https://github.com/openzim/javascript-libzim/tree/470b36920fba421a4c1a83b326e66d8aa0533870).
- [Exact source archive](https://github.com/openzim/javascript-libzim/archive/470b36920fba421a4c1a83b326e66d8aa0533870.tar.gz).
- [Official binary release](https://github.com/openzim/javascript-libzim/releases/download/v0.95/libzim_wasm_0.95.zip).
- Release ZIP SHA-256: `896e4eab4986670ae9c0858312fa5225436e3498990c45df752e0be46eb4fe3d` (matched GitHub's asset digest).
- `libzim-wasm.js`: 136633 bytes; SHA-256 `132bf25528a97dbeae4b33b925062c45aff3d9eb0f8ff3b3a9f3dc85a5f4ceb8`.
- `libzim-wasm.wasm`: 2184660 bytes; SHA-256 `2c30977782b682b84a73445cb8d5b27996ee2b401f508c75b4d6b950956ccbd8`.

The upstream Makefile and Docker recipe fetch/build libzim and dependencies
(including Xapian, ICU, XZ/liblzma and Zstandard); their original notices and
licenses remain applicable. The release is a WASM build, not a newly written
ZIM parser. Its official WORKERFS implementation reads `File.slice(position,
position + length)` through `FileReaderSync` inside a worker. The archive is
not copied into IndexedDB or loaded wholesale into application memory.

The bridge explicitly deletes Emscripten entry/item/blob/result/vector handles
after use. Closing the engine terminates its worker, releasing the WASM heap,
archive descriptor and libzim caches. Runtime file access never uploads the
selected archive and requires no external CDN.

Upstream currently does not expose archive metadata or `hasFulltextIndex` in
its JavaScript bindings. The adapter reports the user-selected filename and
the real article count; it leaves date and index availability unknown rather
than inferring them from an empty search. Full-text quality depends on the
index included by the publisher. Pagination is capped at the first 1000 hits.

The archive UUID is read from the 16 header bytes at offset 8, matching
[libzim's header implementation](https://github.com/openzim/libzim/blob/main/src/fileheader.cpp).
This is an identity/preflight check, not a replacement ZIM parser.
`diagnostics()` reports actual worker file-read calls, cumulative bytes and
largest read, plus the current WASM heap allocation. The counters do not
measure the whole browser process or imply a fixed memory bound.

The binding has no `Item.getSize()` method. The 64 MiB per-resource limit is
therefore enforced after libzim has decoded the item, before transferring it
to the UI; it does not prevent a corrupt or oversized item from consuming
worker memory. Only publisher-trusted archives should be opened. Asynchronous
initialization failures are forwarded to the caller, and closing the worker
releases its allocation even after an initialization failure.
