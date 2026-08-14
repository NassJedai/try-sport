import { Injectable } from '@nestjs/common';
import { SystemClock } from '@try/utils';
import type { Clock } from '@try/utils';

export const CLOCK = Symbol('CLOCK');

/**
 * Time is injected, never read from `new Date()` inside domain services.
 * Booking windows, cancellation policies and check-in windows are all
 * time-dependent, and none of them can be tested honestly against the wall clock.
 */
@Injectable()
export class SystemClockProvider extends SystemClock implements Clock {}
