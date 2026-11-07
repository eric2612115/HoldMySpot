import type { CityConfig } from '../config/cities';
import type { AppParams } from '../config/params';
import { serverAnswers } from '../services/api';
import { useMarket } from './market';
import { bootMockMarket } from './mockMarket';
import { bootServerMarket } from './serverMarket';

let booted = false;

/**
 * Picks the market once per page load: the HoldMySpot server when it answers
 * (fake PayPal mode on 127.0.0.1:8796 in development), else the in-browser
 * market. `?backend=server` insists on the server, `?backend=mock` skips it.
 */
export async function bootMarket(city: CityConfig, params: AppParams): Promise<void> {
  if (booted) return;
  booted = true;
  if (params.backend !== 'mock' && city.id !== 'taipei' && (params.backend === 'server' || (await serverAnswers()))) {
    try {
      await bootServerMarket(city, params);
      return;
    } catch (err) {
      console.warn('The HoldMySpot server did not load; using the in-browser market.', err);
      useMarket.setState({ backend: 'connecting', driver: null, persona: null });
    }
  }
  bootMockMarket(city);
}
