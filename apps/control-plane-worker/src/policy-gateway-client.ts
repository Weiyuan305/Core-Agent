import {
  ClosePolicySessionResponseSchema,
  OpenPolicySessionResponseSchema,
  type ClosePolicySessionRequest,
  type OpenPolicySessionRequest,
  type OpenPolicySessionResponse,
} from "@core-agent/contracts";
import Schema from "typebox/schema";

const openValidator = Schema.Compile(OpenPolicySessionResponseSchema);
const closeValidator = Schema.Compile(ClosePolicySessionResponseSchema);
const maximumResponseBytes = 16 * 1024;

export class PolicyGatewayClientError extends Error {
  public constructor(public readonly retryable: boolean) {
    super("Policy Gateway is unavailable");
    this.name = "PolicyGatewayClientError";
  }
}

function validateOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["policy-mcp-gateway", "127.0.0.1", "localhost"].includes(url.hostname)
      || url.username !== "" || url.password !== "" || !["", "/"].includes(url.pathname)
      || url.search !== "" || url.hash !== "") throw new Error();
    return url.origin;
  } catch { throw new Error("Policy Gateway Worker configuration is invalid"); }
}

async function responseJson(response: Response): Promise<unknown> {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new PolicyGatewayClientError(false);
  }
  if (response.body === null) throw new PolicyGatewayClientError(false);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.byteLength;
    if (length > maximumResponseBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PolicyGatewayClientError(false);
    }
    chunks.push(item.value);
  }
  const text = Buffer.concat(chunks, length).toString("utf8");
  try { return JSON.parse(text) as unknown; } catch { throw new PolicyGatewayClientError(false); }
}

export class PolicyGatewayClient {
  readonly #origin: string;
  readonly #workerToken: string;
  readonly #fetch: typeof fetch;
  public constructor(
    origin: string,
    workerToken: string,
    fetchImplementation: typeof fetch = fetch,
  ) {
    this.#origin = validateOrigin(origin);
    if (workerToken.length < 32 || workerToken.length > 4096 || /[\u0000\r\n]/u.test(workerToken)) {
      throw new Error("Policy Gateway Worker configuration is invalid");
    }
    this.#workerToken = workerToken;
    this.#fetch = fetchImplementation;
  }

  async #post(path: string, body: unknown, tenantId?: string): Promise<Response> {
    try {
      return await this.#fetch(`${this.#origin}${path}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: {
          authorization: `Bearer ${this.#workerToken}`,
          "content-type": "application/json",
          accept: "application/json",
          ...(tenantId === undefined ? {} : { "x-core-agent-tenant-id": tenantId }),
        },
        body: JSON.stringify(body),
      });
    } catch { throw new PolicyGatewayClientError(true); }
  }

  public async open(request: OpenPolicySessionRequest): Promise<OpenPolicySessionResponse> {
    const response = await this.#post("/v1/policy/sessions/open", request);
    if (!response.ok) throw new PolicyGatewayClientError(response.status >= 500);
    const body = await responseJson(response);
    if (!openValidator.Check(body)) throw new PolicyGatewayClientError(false);
    return body as OpenPolicySessionResponse;
  }

  public async close(tenantId: string, request: ClosePolicySessionRequest): Promise<void> {
    const response = await this.#post("/v1/policy/sessions/close", request, tenantId);
    if (!response.ok) throw new PolicyGatewayClientError(response.status >= 500);
    const body = await responseJson(response);
    if (!closeValidator.Check(body) || body.policy_session_id !== request.policy_session_id) {
      throw new PolicyGatewayClientError(false);
    }
  }
}
