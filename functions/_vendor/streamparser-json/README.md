# Vendored streaming JSON parser

Upstream: https://github.com/juanjoDiaz/streamparser-json

Package: `@streamparser/json@0.0.22`, MIT (see LICENSE).

Registry tarball SHA-256:
`977747364021a031e22148909b4191baa6cfb32d87d3e0560a34324a740dfd50`.

`index.js` is the unmodified published ESM implementation, bundled with
esbuild 0.28.1, without minification or source maps. No runtime download or
additional package installation is required by Pages, Workers or tests.

Reproduce from the extracted npm tarball:

```sh
npx esbuild@0.28.1 package/dist/mjs/index.js --bundle --format=esm --platform=browser --target=es2022 --outfile=index.js
```

The integration in `cover-manifest-stream.js` uses a streaming TextDecoder
before parsing and releases each private entry after projecting its public
fields. Tests cover byte-by-byte UTF-8 input, JSON errors, selected entries,
and a 65 MB input with a 64 MB JavaScript heap limit.
