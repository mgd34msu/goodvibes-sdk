/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

type Listener = () => void;

export interface UiReadModel<TSnapshot> {
  getSnapshot(): TSnapshot;
  subscribe(listener: Listener): () => void;
}
