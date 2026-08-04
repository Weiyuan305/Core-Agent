import type { Kysely } from "kysely";

import type { RuntimeDatabase } from "../db/database.js";
import { assertTenantId, type TenantTransaction } from "../db/transaction.js";
import { ConversationRepository, SessionRepository } from "./conversation.js";
import { ActorRepository, MembershipRepository, ProfileRepository, TenantRepository, repositoryContext } from "./resources.js";
import { RuntimeRepository } from "./runtime.js";
import { AgentRunRepository, MessageRepository } from "./run.js";

export interface TenantResourceRepositories {
  readonly tenants: TenantRepository;
  readonly actors: ActorRepository;
  readonly memberships: MembershipRepository;
  readonly profiles: ProfileRepository;
  readonly runtimes: RuntimeRepository;
  readonly conversations: ConversationRepository;
  readonly sessions: SessionRepository;
  readonly runs: AgentRunRepository;
  readonly messages: MessageRepository;
}

export class ResourceRepositories {
  public constructor(private readonly db: Kysely<RuntimeDatabase>) {}

  public forTenant(tenantId: string): TenantResourceRepositories {
    assertTenantId(tenantId);
    return this.fromContext({ tenantId, db: this.db });
  }

  public forTransaction(transaction: TenantTransaction): TenantResourceRepositories {
    return this.fromContext(transaction);
  }

  private fromContext(context: Parameters<typeof repositoryContext>[0]): TenantResourceRepositories {
    const scoped = repositoryContext(context);
    return {
      tenants: new TenantRepository(scoped),
      actors: new ActorRepository(scoped),
      memberships: new MembershipRepository(scoped),
      profiles: new ProfileRepository(scoped),
      runtimes: new RuntimeRepository(scoped),
      conversations: new ConversationRepository(scoped),
      sessions: new SessionRepository(scoped),
      runs: new AgentRunRepository(scoped),
      messages: new MessageRepository(scoped),
    };
  }
}
