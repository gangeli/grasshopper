import { serveMemory, type PortLike } from './MemoryWorkerCore';

/** Worker entry: MapMemory off the main thread (see MemoryWorkerCore / MemoryClient). */
serveMemory(self as unknown as PortLike);
