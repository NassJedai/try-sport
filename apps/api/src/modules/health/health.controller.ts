import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createDatabase } from '@try/database';
import type { Logger } from '@try/logger';
import { Public } from '../../common/auth/auth.guard.js';
import { DATABASE_HANDLE } from '../../common/database.module.js';
import { LOGGER } from '../../common/logger.module.js';

type DatabaseHandle = ReturnType<typeof createDatabase>;

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /**
   * Liveness. Answers "is this process running" and nothing more — it must not
   * touch the database, or a brief database blip would make the orchestrator kill
   * every healthy API instance at once.
   */
  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Liveness probe' })
  health(): { status: 'ok'; uptime: number } {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  /**
   * Readiness. Answers "can this instance serve traffic", which does require the
   * database. A failing readiness check removes the instance from the load
   * balancer without restarting it.
   */
  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Readiness probe: verifies database connectivity' })
  async ready(): Promise<{ status: 'ready' | 'degraded'; checks: Record<string, boolean> }> {
    let databaseOk = false;
    try {
      databaseOk = await this.database.ping();
    } catch (error) {
      this.logger.error({ err: error }, 'readiness check failed: database unreachable');
    }

    return {
      status: databaseOk ? 'ready' : 'degraded',
      checks: { database: databaseOk },
    };
  }
}
