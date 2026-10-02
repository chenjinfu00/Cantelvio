import { AILEGRO_GROUPS, type AilegroGroup } from '@ailegro-score/core';
import type { ComposeRequest, ComposeTask } from '@ailegro-score/ailegro-bridge';
import { useEffect, useMemo, useState } from 'react';
import { BrandText } from '../components/BrandText';
import { IN_ARTIFACT } from '../host';
import { type MessageKey, useT } from '../i18n';
import {
  ADAPTER_TASKS,
  ALL_TASKS,
  DEFAULT_SERVICE_URL,
  MATERIAL_TASKS,
  type PanelSpec,
  type ServiceInfo,
  acceptRun,
  adapterCommand,
  defaultSpec,
  exportRecord,
  exportRequest,
  generateWithService,
  importResultFile,
  pendingRuns,
  pingService,
  rejectRun,
} from '../state/ailegro';
import { pickFile } from '../state/files';
import { getStore, useEditor } from '../state/store';

const SERVICE_KEY = 'ailegro-score:service-url';

function loadServiceUrl(): string {
  try {
    return localStorage.getItem(SERVICE_KEY) || DEFAULT_SERVICE_URL;
  } catch {
    return DEFAULT_SERVICE_URL;
  }
}

export function AilegroPanel() {
  const t = useT();
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const [spec, setSpec] = useState<PanelSpec>(() => defaultSpec(doc, selection));
  const [lastRequest, setLastRequest] = useState<ComposeRequest | null>(null);
  const [serviceUrl, setServiceUrl] = useState(loadServiceUrl);
  const [service, setService] = useState<ServiceInfo | 'offline' | null>(null);
  const [busy, setBusy] = useState(false);
  const runs = useMemo(() => pendingRuns(doc), [doc]);

  // Another document was opened: start from its defaults.
  const generation = useEditor((s) => s.generation);
  useEffect(() => {
    const s = getStore().getState();
    setSpec(defaultSpec(s.doc, s.selection));
    setLastRequest(null);
  }, [generation]);

  // A new range selection retargets the bars to write.
  useEffect(() => {
    if (selection.kind !== 'range') return;
    setSpec((s) => ({
      ...s,
      from: selection.measureFrom,
      count: selection.measureTo - selection.measureFrom + 1,
    }));
  }, [selection]);

  // Keep chosen parts valid when parts are added or removed.
  useEffect(() => {
    setSpec((s) => {
      const ids = new Set(doc.parts.map((p) => p.id));
      const materialParts = s.materialParts.filter((id) => ids.has(id));
      return materialParts.length === s.materialParts.length ? s : { ...s, materialParts };
    });
  }, [doc.parts]);

  const update = (patch: Partial<PanelSpec>) => setSpec((s) => ({ ...s, ...patch }));
  const toggleGroup = (g: AilegroGroup) =>
    update({
      groups: spec.groups.includes(g)
        ? spec.groups.filter((x) => x !== g)
        : AILEGRO_GROUPS.filter((x) => x === g || spec.groups.includes(x)),
    });
  const togglePart = (id: string) =>
    update({
      materialParts: spec.materialParts.includes(id)
        ? spec.materialParts.filter((x) => x !== id)
        : [...spec.materialParts, id],
    });

  const store = getStore().getState;
  const fail = (e: unknown) =>
    store().notify(t('toast.error', { m: (e as Error).message ?? String(e) }), 'error');

  const onExport = () => {
    try {
      setLastRequest(exportRequest(spec));
    } catch (e) {
      fail(e);
    }
  };
  const onImport = async () => {
    const file = await pickFile('.json,application/json');
    if (file) await importResultFile(file);
  };
  const onPing = async () => {
    try {
      localStorage.setItem(SERVICE_KEY, serviceUrl);
    } catch {
      /* ignore */
    }
    try {
      setService(await pingService(serviceUrl));
    } catch {
      setService('offline');
    }
  };
  const onGenerate = async () => {
    setBusy(true);
    try {
      await generateWithService(serviceUrl, spec);
      setService((s) => (s === 'offline' ? null : s));
    } catch (e) {
      if (e instanceof TypeError) setService('offline');
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const needsMaterial = MATERIAL_TASKS.includes(spec.task);
  const taskLabel = (task: ComposeTask) =>
    t(`ai.task.${task}` as MessageKey) + (ADAPTER_TASKS.includes(task) ? '' : t('ai.task.pending'));

  return (
    <div className="panel-body ai-panel">
      <h3>
        <BrandText text={t('ai.title')} />
      </h3>
      <p className="hint">
        <BrandText text={t('ai.intro')} />
      </p>

      <label className="field">
        <span>{t('ai.task')}</span>
        <select value={spec.task} onChange={(e) => update({ task: e.target.value as ComposeTask })}>
          {ALL_TASKS.map((task) => (
            <option key={task} value={task}>
              {taskLabel(task)}
            </option>
          ))}
        </select>
      </label>

      <div className="row">
        <label className="field">
          <span>{t('ai.from')}</span>
          <input
            type="number"
            min={1}
            max={doc.measures.length + 1}
            value={spec.from + 1}
            onChange={(e) => update({ from: Math.max(0, (Number(e.target.value) || 1) - 1) })}
          />
        </label>
        <label className="field">
          <span>{t('ai.count')}</span>
          <input
            type="number"
            min={1}
            max={64}
            value={spec.count}
            onChange={(e) =>
              update({ count: Math.max(1, Math.min(64, Number(e.target.value) || 1)) })
            }
          />
        </label>
      </div>

      <fieldset>
        <legend>{t('ai.groups')}</legend>
        <div className="checks">
          {AILEGRO_GROUPS.map((g) => (
            <label key={g} className="check">
              <input
                type="checkbox"
                checked={spec.groups.includes(g)}
                onChange={() => toggleGroup(g)}
              />
              {t(`g.${g}` as MessageKey)}
            </label>
          ))}
        </div>
      </fieldset>

      {needsMaterial && (
        <fieldset>
          <legend>{t('ai.material')}</legend>
          <div className="checks">
            {doc.parts.map((p) => (
              <label key={p.id} className="check">
                <input
                  type="checkbox"
                  checked={spec.materialParts.includes(p.id)}
                  onChange={() => togglePart(p.id)}
                />
                {p.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <label className="field">
        <span>{t('ai.chordMode')}</span>
        <select
          value={spec.task === 'melody-from-chords' ? 'given' : spec.chordMode}
          disabled={spec.task === 'melody-from-chords'}
          onChange={(e) => update({ chordMode: e.target.value as PanelSpec['chordMode'] })}
        >
          <option value="free">{t('ai.chord.free')}</option>
          <option value="hold">{t('ai.chord.hold')}</option>
          <option value="bar">{t('ai.chord.bar')}</option>
          <option value="given">{t('ai.chord.given')}</option>
        </select>
      </label>

      <details className="advanced">
        <summary>{t('ai.advanced')}</summary>
        <div className="row">
          <label className="field">
            <span>{t('ai.seed')}</span>
            <input
              type="number"
              value={spec.seed}
              onChange={(e) => update({ seed: Math.trunc(Number(e.target.value) || 0) })}
            />
          </label>
          <label className="field">
            <span>{t('ai.temperature')}</span>
            <input
              type="number"
              step={0.05}
              min={0.05}
              max={2}
              value={spec.temperature}
              onChange={(e) => update({ temperature: Number(e.target.value) || 0.9 })}
            />
          </label>
        </div>
        <div className="row">
          <label className="field">
            <span>{t('ai.topP')}</span>
            <input
              type="number"
              step={0.01}
              min={0.05}
              max={1}
              value={spec.topP}
              onChange={(e) => update({ topP: Number(e.target.value) || 0.95 })}
            />
          </label>
          <label className="field">
            <span>{t('ai.density')}</span>
            <select
              value={spec.density ?? ''}
              onChange={(e) =>
                update({ density: e.target.value === '' ? null : Number(e.target.value) })
              }
            >
              <option value="">{t('ai.auto')}</option>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>

      <section className="ai-actions">
        <h4>
          <BrandText text={t('ai.viaService')} />
        </h4>
        {IN_ARTIFACT ? (
          // A page on claude.ai cannot reach a server on this computer; files work everywhere.
          <p className="hint">
            <BrandText text={t('ai.serviceUnavailable')} />
          </p>
        ) : (
          <>
            <div className="row tight">
              <input
                className="grow"
                value={serviceUrl}
                onChange={(e) => setServiceUrl(e.target.value)}
                aria-label={t('ai.service')}
                spellCheck={false}
              />
              <button onClick={() => void onPing()}>{t('ai.ping')}</button>
            </div>
            {service && (
              <p className={`status-line ${service === 'offline' ? 'bad' : 'good'}`}>
                {service === 'offline'
                  ? t('ai.offline')
                  : t('ai.online', {
                      m: `${service.model ?? '?'}${service.mock ? ' (mock)' : ''}`,
                    })}
              </p>
            )}
            <button
              className="primary wide"
              disabled={busy || spec.groups.length === 0}
              onClick={() => void onGenerate()}
            >
              {busy ? t('ai.generating') : `✦ ${t('ai.generate')}`}
            </button>
          </>
        )}

        <h4>{t('ai.viaFiles')}</h4>
        <div className="row tight wrap">
          <button onClick={onExport} disabled={spec.groups.length === 0}>
            {t('ai.export')}
          </button>
          <button onClick={() => void onImport()}>{t('ai.import')}</button>
          <button onClick={() => exportRecord()}>{t('ai.exportRecord')}</button>
        </div>
        {lastRequest && (
          <div className="command">
            <p className="hint">
              <BrandText text={t('ai.command')} />
            </p>
            <pre>{adapterCommand(lastRequest, 'file')}</pre>
            <button
              className="small"
              onClick={() => {
                // some views refuse clipboard writes; the command stays selectable in the box
                navigator.clipboard?.writeText(adapterCommand(lastRequest, 'file')).catch(() => {});
              }}
            >
              {t('ai.copy')}
            </button>
          </div>
        )}
      </section>

      <section className="ai-review">
        <h4>{t('ai.pending')}</h4>
        {runs.length === 0 ? (
          <p className="hint">{t('ai.none')}</p>
        ) : (
          <ul className="runs">
            {runs.map((r) => (
              <li key={r.runId}>
                <div className="run-info">
                  <strong>{r.model}</strong>
                  <span>
                    {t('ai.runSummary', {
                      n: r.notes,
                      a: r.firstMeasure + 1,
                      b: r.lastMeasure + 1,
                    })}
                    {r.chords ? ` · ${t('ai.runChords', { c: r.chords })}` : ''}
                  </span>
                </div>
                <div className="run-actions">
                  <button className="accept" onClick={() => acceptRun(r.runId)}>
                    ✓ {t('ai.accept')}
                  </button>
                  <button className="reject" onClick={() => rejectRun(r.runId)}>
                    ✕ {t('ai.reject')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
