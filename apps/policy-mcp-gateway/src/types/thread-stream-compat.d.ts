import "worker_threads";

declare module "worker_threads" {
  type TransferListItem = Transferable;
}
