import { readParams } from '../config/params';
import { createMarketClock } from '../services/clock';
import { createPayments } from '../services/payments';

/** App-wide singletons, created once per page load. */
export const params = readParams();
export const clock = createMarketClock(params.speed);
export const payments = createPayments();
