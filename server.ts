// Root entrypoint for local-path plugin loading (OpenCode resolves <dir>/server).
// npm installs keep using package.json exports instead.
export { default } from "./src/server/index"
export * from "./src/server/index"
