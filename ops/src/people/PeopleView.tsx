import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllCommunityModule, themeQuartz } from 'ag-grid-community';
import type { ColDef, ICellRendererParams, RowClassParams } from 'ag-grid-community';
import type { Market } from '../data/useMarket.ts';
import type { OpsBackend } from '../data/backend.ts';
import type { CasePhoto, PeopleCase } from './cases.ts';
import '../styles/people.css';

/**
 * The third page of the ops console: the hard calls the AI and the rules could
 * not settle, one row per case. Drawn with AG Grid Community only (no Enterprise
 * module, so no licence and no watermark); every button goes to the server's
 * own routes, or stays in this browser on the replay (D-160).
 */

interface Act {
  run: (id: string, what: (b: OpsBackend) => Promise<string>) => void;
  busy: string | null;
  backend: OpsBackend;
  /** The note a person is editing for a dispute (kept when the grid redraws). */
  notes: Map<string, string>;
  photoUrl: (p: CasePhoto) => Promise<string | null>;
}

const MODULES = [AllCommunityModule];
const KIND_ORDER: Readonly<Record<PeopleCase['kind'], number>> = { receipt: 0, refund: 1, dispute: 2 };

const THEME = themeQuartz.withParams({
  accentColor: '#5B4CF0',
  backgroundColor: '#FFFFFF',
  foregroundColor: '#23253A',
  borderColor: '#E6E7F1',
  fontFamily: "'Figtree Variable', system-ui, sans-serif",
  fontSize: 14,
  headerBackgroundColor: '#F6F4FF',
  headerTextColor: '#4A4E68',
  headerFontWeight: 700,
  headerFontSize: 12.5,
  rowBorder: { color: '#EEF0F6', width: 1 },
  columnBorder: { color: 'transparent', width: 0 },
  wrapperBorder: false,
  wrapperBorderRadius: 16,
  rowHoverColor: '#FBFAFF',
  spacing: 8,
  cellHorizontalPadding: 14,
});

function KindCell({ data }: ICellRendererParams<PeopleCase>) {
  if (!data) return null;
  return (
    <div className="pc-kind">
      <span className={`pc-pill pc-pill-${data.kind}`}>{data.kindLabel}</span>
    </div>
  );
}

function WhoCell({ data }: ICellRendererParams<PeopleCase>) {
  if (!data) return null;
  return (
    <div className="pc-who">
      <strong>{data.who}</strong>
      <span>{data.what}</span>
      <span className="pc-amount">{data.amountText}</span>
    </div>
  );
}

function WhyCell({ data }: ICellRendererParams<PeopleCase>) {
  if (!data) return null;
  return <div className="pc-why">{data.why}</div>;
}

function Photo({ photo, act }: { photo: CasePhoto; act: Act }) {
  const [url, setUrl] = useState<string | null>(photo.url ?? null);
  useEffect(() => {
    if (photo.url) return;
    let live = true;
    void act.photoUrl(photo).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [photo, act]);
  if (!url) return <span className="pc-photo pc-photo-empty">{photo.label}</span>;
  return (
    <a className="pc-photo" href={url} target="_blank" rel="noreferrer" title={`${photo.label}: open full size`}>
      <img src={url} alt={photo.label} loading="lazy" />
      <span>{photo.label}</span>
    </a>
  );
}

function NoteCell({ data, context }: ICellRendererParams<PeopleCase, unknown, Act>) {
  const act = context as Act;
  const draft = data?.aiNote ?? '';
  const [text, setText] = useState(act.notes.get(data?.id ?? '') ?? draft);
  useEffect(() => {
    if (data && !act.notes.has(data.id)) setText(draft);
  }, [act, data, draft]);
  if (!data) return null;
  // A provider/model/mode stamp, in plain words; a rules-only run says no model read it.
  const stampLine = data.template
    ? (data.templateWhy ?? 'Written from the template.')
    : data.aiStamp?.startsWith('fake/')
      ? `Rules-only reading, no AI model (${data.aiStamp})`
      : data.aiStamp
        ? `AI read this: ${data.aiStamp}`
        : null;
  const stamp = stampLine ? <span className="pc-stamp">{stampLine}</span> : null;
  if (data.kind === 'dispute' && !data.evidenceSent && !data.decided) {
    return (
      <div className="pc-note">
        <textarea
          aria-label={`Note to PayPal for ${data.who}`}
          value={text}
          rows={6}
          onChange={(e) => {
            setText(e.target.value);
            act.notes.set(data.id, e.target.value);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {stamp}
        {data.attachments.length > 0 && <span className="pc-attached">Send attaches: {data.attachments.join(', ')}</span>}
      </div>
    );
  }
  return (
    <div className="pc-note">
      {data.aiNote ? <p>{data.aiNote}</p> : <p className="pc-none">No AI on this case: code and a person.</p>}
      {stamp}
      {data.photos.length > 0 && (
        <div className="pc-photos">
          {data.photos.map((p) => (
            <Photo key={p.fileId ?? p.url} photo={p} act={act} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionsCell({ data, context }: ICellRendererParams<PeopleCase, unknown, Act>) {
  const act = context as Act;
  const [amount, setAmount] = useState(data?.refundableCents ? ((data.refundableCents as number) / 100).toFixed(2) : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!data) return null;
  const busy = act.busy === data.id;
  const note = () => act.notes.get(data.id) ?? data.aiNote ?? '';

  if (data.kind === 'receipt') {
    return (
      <div className="pc-actions">
        <button type="button" className="pc-btn pc-btn-pass" disabled={busy} onClick={() => act.run(data.id, (b) => b.reviewProof(data.proofId!, 'pass', 'Checked by a person.'))}>
          Pass
        </button>
        <button type="button" className="pc-btn pc-btn-fail" disabled={busy} onClick={() => act.run(data.id, (b) => b.reviewProof(data.proofId!, 'fail', 'Failed by a person.'))}>
          Fail
        </button>
        <span className="pc-hint">No charge until the receipt passes.</span>
      </div>
    );
  }

  if (data.kind === 'refund') {
    const cents = Math.round(Number(amount) * 100);
    const max = data.refundableCents ?? 0;
    const bad = !Number.isFinite(cents) || cents <= 0 || cents > max;
    return (
      <div className="pc-actions pc-actions-col">
        <div className="pc-refund">
          <label>
            <span>Amount</span>
            <input aria-label={`Refund amount for ${data.who}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
          <label className="pc-grow">
            <span>Reason</span>
            <input aria-label={`Refund reason for ${data.who}`} value={reason} placeholder="Why the money goes back" maxLength={200} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          </label>
        </div>
        <div className="pc-actions">
          <button
            type="button"
            className="pc-btn pc-btn-money"
            disabled={busy || bad || reason.trim() === ''}
            onClick={() => {
              setError(null);
              act.run(data.id, (b) => b.refund(data.jobId!, cents, reason.trim()));
            }}
          >
            Refund
          </button>
          {data.manual ? null : (
            <button type="button" className="pc-btn" disabled={busy} onClick={() => act.run(data.id, (b) => b.closeRefundRequest(data.jobId!, 'Closed by a person without a refund.'))}>
              Decline
            </button>
          )}
          <span className="pc-hint">{bad ? `Up to $${(max / 100).toFixed(2)}.` : `Up to $${(max / 100).toFixed(2)} goes back.`}</span>
        </div>
        {error && <span className="pc-error">{error}</span>}
      </div>
    );
  }

  // Dispute
  const sent = data.evidenceSent === true;
  const done = data.decided ?? null;
  return (
    <div className="pc-actions pc-actions-col">
      <div className="pc-actions">
        <button
          type="button"
          className="pc-btn pc-btn-money"
          disabled={busy || sent || Boolean(done) || note().trim() === ''}
          onClick={() => act.run(data.id, (b) => b.sendEvidence(data.disputeId!, note(), data.hasTracking === true))}
        >
          {sent ? 'Evidence sent' : 'Send'}
        </button>
        <button type="button" className="pc-btn" disabled={busy || Boolean(done)} onClick={() => act.run(data.id, (b) => b.acceptClaim(data.disputeId!, note() || 'We accept this claim.'))}>
          Accept claim
        </button>
      </div>
      <div className="pc-actions">
        <button type="button" className="pc-btn pc-btn-test" disabled={busy || Boolean(done)} onClick={() => act.run(data.id, (b) => b.adjudicate(data.disputeId!, 'seller_favor'))}>
          Settle for seller
        </button>
        <button type="button" className="pc-btn pc-btn-test" disabled={busy || Boolean(done)} onClick={() => act.run(data.id, (b) => b.adjudicate(data.disputeId!, 'buyer_favor'))}>
          Settle for buyer
        </button>
        <span className="pc-hint">Settle: sandbox only</span>
      </div>
      {sent && <span className="pc-hint">Evidence is with PayPal.</span>}
      {done && <span className="pc-hint">{done}</span>}
    </div>
  );
}

const columns: ColDef<PeopleCase>[] = [
  { headerName: 'Kind', field: 'kindLabel', cellRenderer: KindCell, width: 170, sortable: false, suppressMovable: true },
  { headerName: 'Who and how much', field: 'who', cellRenderer: WhoCell, width: 220, sortable: false, suppressMovable: true },
  { headerName: 'Why it reached a person', field: 'why', cellRenderer: WhyCell, flex: 1.05, minWidth: 180, sortable: false, suppressMovable: true },
  { headerName: "The AI's note", field: 'aiNote', cellRenderer: NoteCell, flex: 1.5, minWidth: 260, sortable: false, suppressMovable: true },
  { headerName: 'What a person can do', field: 'id', cellRenderer: ActionsCell, width: 340, sortable: false, suppressMovable: true },
];

export default function PeopleView({ market }: { market: Market }) {
  const { snapshot, backend, act } = market;
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [opened, setOpened] = useState<PeopleCase[]>([]);
  const grid = useRef<AgGridReact<PeopleCase>>(null);
  const notes = useRef(new Map<string, string>()).current;
  const urls = useRef(new Map<string, string>()).current;

  const rows = useMemo(() => {
    const live = new Set(snapshot.people.map((c) => c.id));
    return [...snapshot.people, ...opened.filter((c) => !live.has(c.id))].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  }, [snapshot.people, opened]);

  // A row a person opened drops out once its job leaves the refundable list.
  useEffect(() => {
    setOpened((list) => list.filter((c) => backend.kind === 'mock' || snapshot.refundable.some((r) => r.jobId === c.jobId)));
  }, [snapshot.refundable, backend.kind]);

  const photoUrl = useCallback(
    async (p: CasePhoto): Promise<string | null> => {
      if (!p.fileId) return p.url ?? null;
      const cached = urls.get(p.fileId);
      if (cached) return cached;
      const url = await backend.photoUrl(p.fileId);
      if (url) urls.set(p.fileId, url);
      return url;
    },
    [backend, urls],
  );

  const run = useCallback<Act['run']>(
    (id, what) => {
      setBusy(id);
      setMessage(null);
      void act(what)
        .then((text) => {
          setMessage({ text, bad: false });
          setOpened((list) => list.filter((c) => c.id !== id));
          notes.delete(id);
        })
        .catch((e: unknown) => setMessage({ text: e instanceof Error ? e.message : String(e), bad: true }))
        .finally(() => setBusy(null));
    },
    [act, notes],
  );

  // One stable context object: the grid keeps it, and a row change or busy change redraws the cells.
  const context = useRef<Act>({ run, busy, backend, notes, photoUrl }).current;
  context.run = run;
  context.busy = busy;
  context.backend = backend;
  context.photoUrl = photoUrl;
  useEffect(() => {
    grid.current?.api?.refreshCells({ force: true });
  }, [busy]);
  const counts = useMemo(() => {
    const c = { receipt: 0, refund: 0, dispute: 0 };
    for (const r of rows) c[r.kind]++;
    return c;
  }, [rows]);

  const pick = (jobId: string) => {
    const job = snapshot.refundable.find((r) => r.jobId === jobId);
    if (!job) return;
    setOpened((list) => [...list.filter((c) => c.jobId !== jobId), backend.manualRefund(jobId)!].filter(Boolean));
  };

  return (
    <div className="people">
      <header className="people-head">
        <div>
          <h1>Needs a person</h1>
          <p>AI runs the routine; only the hard calls reach a person. Receipts that fail the checks move $0.</p>
        </div>
        <div className="people-tags" aria-label="Open cases">
          <span className="pc-pill pc-pill-receipt">{counts.receipt} receipt</span>
          <span className="pc-pill pc-pill-refund">{counts.refund} refund</span>
          <span className="pc-pill pc-pill-dispute">{counts.dispute} dispute</span>
          {backend.kind === 'mock' && <span className="people-mode">Replay: buttons stay in this browser</span>}
        </div>
        {snapshot.refundable.length > 0 && (
          <label className="people-pick">
            <span>Refund a job</span>
            <select value="" onChange={(e) => pick(e.target.value)}>
              <option value="">Pick a job with captured money</option>
              {snapshot.refundable.map((r) => (
                <option key={r.jobId} value={r.jobId}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>
      {message && (
        <div className={`people-flash ${message.bad ? 'is-bad' : ''}`} role="status">
          {message.text}
        </div>
      )}
      <div className="people-grid">
        <AgGridReact<PeopleCase>
          ref={grid}
          modules={MODULES}
          theme={THEME}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ wrapText: true, autoHeight: true, resizable: false, suppressHeaderMenuButton: true, equals: () => false, cellStyle: { lineHeight: '1.4' } }}
          context={context}
          getRowId={(p) => p.data.id}
          getRowClass={(p: RowClassParams<PeopleCase>) => (p.data ? `people-row-${p.data.kind}` : undefined)}
          suppressCellFocus
          suppressHorizontalScroll
          suppressRowHoverHighlight={false}
          animateRows
          overlayNoRowsTemplate='<span class="people-empty">Nothing needs a person right now. The AI and the rules have the rest.</span>'
        />
      </div>
    </div>
  );
}
