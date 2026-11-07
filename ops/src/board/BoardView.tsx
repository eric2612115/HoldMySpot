import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Market } from '../data/useMarket.ts';
import { buildBars, buildRows } from './boardModel.ts';
import { MapPanel } from './MapPanel.tsx';
import { QueuerBoard } from './QueuerBoard.tsx';
import { ReschedulerPanel } from './ReschedulerPanel.tsx';

export function BoardView({ market }: { market: Market }) {
  const { snapshot, at } = market;
  const { bundle, proposals } = snapshot;
  const bars = useMemo(() => buildBars(bundle, proposals, at), [bundle, proposals, at]);
  const rows = useMemo(() => buildRows(bundle, proposals, at), [bundle, proposals, at]);
  const firstAlert = proposals.find((p) => p.status === 'open');
  const [selected, setSelected] = useState<{ id: string; shopId: string | null } | null>(
    firstAlert ? { id: firstAlert.queuerId, shopId: firstAlert.shopId } : rows[0] ? { id: rows[0].id, shopId: rows[0].shopId } : null,
  );
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const onSelect = useCallback((id: string, shopId: string | null) => setSelected({ id, shopId }), []);
  const validateMove = useCallback((jobId: string, to: string) => market.backend.moveProblem(jobId, to, at), [market.backend, at]);
  const onMove = useCallback(
    async (jobId: string, to: string) => {
      const problem = await market.move(jobId, to);
      setToast(problem ?? "Moved. The job now runs at that offer's current fee.");
      return problem;
    },
    [market],
  );
  const onApprove = useCallback(
    (id: string) => {
      void market.approve(id).then(() => setToast('Approved. The board shows the new plan.'));
    },
    [market],
  );

  const selectedRow = rows.find((r) => r.id === selected?.id);
  const selectedShop = selected?.shopId ?? selectedRow?.shopId ?? null;

  return (
    <div className="board">
      <section className="board-main" aria-label="Queuer board">
        <div className="board-head">
          <div>
            <h1>Queuers today</h1>
            <p>Japantown shops, San Francisco. Fees step down once a queuer checks in. Drag a job to move it.</p>
          </div>
          <div className="legend" aria-label="Legend">
            <span className="k-window"><i />On the way</span>
            <span className="k-line"><i />In line</span>
            <span className="k-clock"><i />Fee clock</span>
            <span className="k-job"><i />Job</span>
            <span className="k-ghost"><i />Proposed</span>
          </div>
        </div>
        <QueuerBoard
          bars={bars}
          rows={rows}
          bundle={bundle}
          now={at}
          selectedId={selected?.id ?? null}
          onSelect={onSelect}
          validateMove={validateMove}
          onMove={onMove}
        />
      </section>
      <aside className="side">
        <MapPanel rows={rows} positions={bundle.positions} selectedId={selected?.id ?? null} selectedShopId={selectedShop} onSelect={onSelect} />
        <ReschedulerPanel
          proposals={proposals}
          notes={bundle.notes}
          now={at}
          serverMode={market.backend.kind === 'server'}
          onApprove={onApprove}
          onShow={(id, shopId) => setSelected({ id, shopId })}
        />
      </aside>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
