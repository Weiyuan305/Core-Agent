import "worker_threads";

declare module "worker_threads" {
  /** Compatibility alias for thread-stream 4.x with the Node 26 type surface. */
  type TransferListItem = Transferable;
}
