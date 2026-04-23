export type HookPhase = 'before' | 'after';

export interface PluginContext {
  logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  storage: Map<string, unknown>;
  meta: {
    idempotencyKey?: string;
    requestId: string;
    timestamp: Date;
    [key: string]: unknown;
  };
}

export type HookHandler = (ctx: PluginContext, input: any, next: () => Promise<any>) => Promise<any>;

export interface RevenuePluginDefinition {
  name: string;
  hooks?: Record<string, HookHandler>;
}

export class PluginManager {
  private plugins: RevenuePluginDefinition[] = [];

  register(plugin: RevenuePluginDefinition): void {
    this.plugins.push(plugin);
  }

  getHooks(hookName: string): HookHandler[] {
    return this.plugins
      .filter((p) => p.hooks?.[hookName])
      .map((p) => p.hooks![hookName]);
  }

  async executeHook(hookName: string, ctx: PluginContext, input: any, execute: () => Promise<any>): Promise<any> {
    const hooks = this.getHooks(hookName);
    if (hooks.length === 0) return execute();

    let index = 0;
    const next = async (): Promise<any> => {
      if (index < hooks.length) {
        const hook = hooks[index++];
        return hook(ctx, input, next);
      }
      return execute();
    };
    return next();
  }
}
