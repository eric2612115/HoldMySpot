import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Brain } from '../agents/brain.ts';
import type { Proposal } from '../agents/rescheduler.ts';
import { useAgentProposals } from '../agents/reschedulerAgent.ts';
import type { Market } from '../data/useMarket.ts';
import { buildBars, buildRows } from './boardModel.ts';
import { MapPanel } from './MapPanel.tsx';
import { QueuerBoard } from './QueuerBoard.tsx';
import { ReschedulerPanel } from './ReschedulerPanel.tsx';

export function BoardView({ market, brain }: { market: Market; brain: Brain }) {
  const { snapshot, at } = market;
  const { bundle } = snapshot;
  // The rescheduler: the rules' problems and options, with the model's pick merged in (D-101).
  const { proposals, error: agentError } = useAgentProposals(snapshot.proposals, brain, at);
  const [preview, setPreview] = useState<Record<string, string | null>>({});
  const bars = useMemo(() => buildBars(bundle, proposals, at, preview), [bundle, proposals, at, preview]);
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
    (proposal: Proposal, optionId: string) => {
      void market.approve(proposal, optionId).then((note) => setToast(note));
      setPreview((p) => ({ ...p, [proposal.id]: null }));
    },
    [market],
  );
  const onPreview = useCallback((proposalId: string, optionId: string | null) => setPreview((p) => (p[proposalId] === optionId ? p : { ...p, [proposalId]: optionId })), []);

  const selectedRow = rows.find((r) => r.id === selected?.id);
  const selectedShop = selected?.shopId ?? selectedRow?.shopId ?? null;

  return (
    <div className="board">
      <section className="board-main" aria-label="Queuer board">
        <div className="board-head">
          <div>
            <h1>Queuers today</h1>
            <p>Japantown shops, San Francisco. Fees step down once a queuer checks in. Drag a job to another queuer, or approve the rescheduler's move.</p>
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
          onRefused={(reason) => setToast(`Not moved: ${reason}`)}
        />
      </section>
      <aside className="side">
        <MapPanel rows={rows} positions={bundle.positions} selectedId={selected?.id ?? null} selectedShopId={selectedShop} onSelect={onSelect} />
        <ReschedulerPanel
          proposals={proposals}
          notes={bundle.notes}
          now={at}
          brain={brain}
          agentError={agentError}
          onApprove={onApprove}
          onShow={(id, shopId) => setSelected({ id, shopId })}
          onPreview={onPreview}
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
