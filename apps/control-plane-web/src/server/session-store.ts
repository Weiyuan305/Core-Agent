import { randomBytes as nodeRandomBytes } from "node:crypto";

import type { ClientConversation } from "../shared/protocol.js";

const publicConversationPattern = /^chat_[a-f0-9]{32}$/u;
const MAX_CONVERSATIONS = 100;
const MAX_COLLISION_ATTEMPTS = 8;

type RandomBytes = (size: number) => Buffer;

export interface ClientConversationStore {
  readonly add: (internalConversationId: string) => ClientConversation;
  readonly list: () => readonly ClientConversation[];
  readonly resolve: (publicConversationId: string) => string | undefined;
}

interface ConversationStoreOptions {
  readonly randomBytes?: RandomBytes;
}

function invalidConversation(): Error {
  return new Error("CLIENT_CONVERSATION_FAILED");
}

function validateInternalConversationId(value: string): void {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 255
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw invalidConversation();
}

function createPublicId(randomBytes: RandomBytes): string {
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw invalidConversation();
  return `chat_${bytes.toString("hex")}`;
}

export function createClientConversationStore(options: ConversationStoreOptions = {}): ClientConversationStore {
  const randomBytes = options.randomBytes ?? nodeRandomBytes;
  const publicToInternal = new Map<string, string>();
  const internalToPublic = new Map<string, ClientConversation>();

  return Object.freeze({
    add(internalConversationId: string): ClientConversation {
      validateInternalConversationId(internalConversationId);
      const existing = internalToPublic.get(internalConversationId);
      if (existing !== undefined) return existing;
      if (publicToInternal.size >= MAX_CONVERSATIONS) throw invalidConversation();

      let publicId: string | undefined;
      for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
        const candidate = createPublicId(randomBytes);
        if (!publicToInternal.has(candidate)) {
          publicId = candidate;
          break;
        }
      }
      if (publicId === undefined) throw invalidConversation();
      const conversation = Object.freeze({
        id: publicId,
        title: `对话 ${publicToInternal.size + 1}`,
      });
      publicToInternal.set(publicId, internalConversationId);
      internalToPublic.set(internalConversationId, conversation);
      return conversation;
    },
    list(): readonly ClientConversation[] {
      return Object.freeze([...internalToPublic.values()]);
    },
    resolve(publicConversationId: string): string | undefined {
      if (typeof publicConversationId !== "string" || !publicConversationPattern.test(publicConversationId)) {
        return undefined;
      }
      return publicToInternal.get(publicConversationId);
    },
  });
}
