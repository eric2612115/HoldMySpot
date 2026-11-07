import { ladder, type StepDownSchedule } from '@holdmyspot/shared';
import { formatUsd, type Cents } from '../domain/money';

/** The fee ladder as a staircase: steps already taken are solid, the rest are dashed. Before check-in the whole ladder is a preview. */
export function PriceStairs({ schedule, now, maxCents, hue, preview = false }: { schedule: StepDownSchedule; now: number; maxCents?: Cents; hue: string; preview?: boolean }) {
  const steps = ladder(schedule);
  const n = steps.length; // number of plateaus, the last one is the floor
  const W = 320;
  const H = 92;
  const padX = 6;
  const padT = 10;
  const padB = 16;
  const span = Math.max(1, schedule.openCents - schedule.floorCents);
  const x = (i: number) => padX + (i / n) * (W - padX * 2);
  const y = (c: Cents) => padT + (1 - (c - schedule.floorCents) / span) * (H - padT - padB);

  let d = '';
  steps.forEach((s, i) => {
    d += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(s.priceCents).toFixed(1)} L${x(i + 1).toFixed(1)},${y(s.priceCents).toFixed(1)} `;
  });
  const progress = preview ? 0 : Math.min(n, Math.max(0, (now - schedule.startsAt) / schedule.intervalMs));
  const cx = x(progress);
  const current = steps[Math.min(n - 1, Math.floor(progress))];

  return (
    <svg className="stairs" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fee steps from opening to floor">
      <defs>
        <clipPath id="stairs-past">
          <rect x="0" y="0" width={cx} height={H} />
        </clipPath>
        <clipPath id="stairs-future">
          <rect x={cx} y="0" width={W - cx} height={H} />
        </clipPath>
      </defs>
      <line x1={padX} x2={W - padX} y1={H - padB + 6} y2={H - padB + 6} className="stairs__base" />
      <path d={d} className="stairs__future" clipPath="url(#stairs-future)" />
      <path d={d} className="stairs__past" style={{ stroke: hue }} clipPath="url(#stairs-past)" />
      {maxCents !== undefined && maxCents >= schedule.floorCents && maxCents <= schedule.openCents && (
        <g>
          <line x1={padX} x2={W - padX} y1={y(maxCents)} y2={y(maxCents)} className="stairs__max" />
          <text x={W - padX} y={y(maxCents) - 4} textAnchor="end" className="stairs__maxlabel">
            your max fee {formatUsd(maxCents)}
          </text>
        </g>
      )}
      <circle cx={cx} cy={y(current.priceCents)} r="9" className="stairs__ping" style={{ fill: hue }} />
      <circle cx={cx} cy={y(current.priceCents)} r="5" className="stairs__dot" style={{ fill: hue }} />
      <text x={padX} y={H - 1} className="stairs__axis">
        opens {formatUsd(schedule.openCents)}
      </text>
      <text x={W - padX} y={H - 1} textAnchor="end" className="stairs__axis">
        floor {formatUsd(schedule.floorCents)}
      </text>
    </svg>
  );
}
