/**
 * Guards tenant/domain-scoped async reads against out-of-order responses.
 *
 * Dynamic `[tenant]` navigation reuses the same React component. A request
 * started for tenant A can therefore finish after tenant B has already
 * mounted. The sequence is tracked per channel so unrelated reads (catalog,
 * runs, drafts, tools, …) do not cancel one another, while a newer read of the
 * same resource always supersedes the older one.
 */

export interface FactoryRequestScope {
  tenant: string;
  domain?: string;
}

export interface FactoryRequestTicket {
  channel: string;
  sequence: number;
  scopeKey: string;
}

export function factoryRequestScopeKey(scope: FactoryRequestScope): string {
  // JSON avoids delimiter collisions in valid (and future) domain ids.
  return JSON.stringify([scope.tenant, scope.domain ?? null]);
}

export class FactoryRequestGate {
  private readonly latest = new Map<string, number>();

  begin(channel: string, scope: FactoryRequestScope): FactoryRequestTicket {
    const sequence = (this.latest.get(channel) ?? 0) + 1;
    this.latest.set(channel, sequence);
    return { channel, sequence, scopeKey: factoryRequestScopeKey(scope) };
  }

  isCurrent(
    ticket: FactoryRequestTicket,
    currentScope: FactoryRequestScope,
  ): boolean {
    return (
      this.latest.get(ticket.channel) === ticket.sequence &&
      ticket.scopeKey === factoryRequestScopeKey(currentScope)
    );
  }

  invalidate(channel: string): void {
    this.latest.set(channel, (this.latest.get(channel) ?? 0) + 1);
  }
}
