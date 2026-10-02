import { BrandText } from '../components/BrandText';
import { type MessageKey, useT } from '../i18n';
import { type PanelId, getStore, useEditor } from '../state/store';
import { AilegroPanel } from './AilegroPanel';
import { InstrumentsPanel } from './InstrumentsPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { TextInputPanel } from './TextInputPanel';

const TABS: readonly { id: PanelId; label: MessageKey; icon: string }[] = [
  { id: 'ailegro', label: 'panel.ailegro', icon: '✦' },
  { id: 'instruments', label: 'panel.instruments', icon: '♫' },
  { id: 'text', label: 'panel.text', icon: '⌨' },
  { id: 'properties', label: 'panel.properties', icon: '⚙' },
];

export function SidePanel() {
  const t = useT();
  const panel = useEditor((s) => s.panel);
  const setPanel = getStore().getState().setPanel;
  return (
    <aside className={`side ${panel ? 'open' : 'closed'}`}>
      <div className="tabs" role="tablist" aria-orientation="vertical">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={panel === tab.id}
            className={panel === tab.id ? 'on' : ''}
            title={t(tab.label)}
            onClick={() => setPanel(panel === tab.id ? null : tab.id)}
          >
            <span className="tab-icon" aria-hidden>
              {tab.icon}
            </span>
            <span className="tab-label">
              <BrandText text={t(tab.label)} />
            </span>
          </button>
        ))}
      </div>
      {panel && (
        <div className="panel" role="tabpanel">
          {panel === 'ailegro' && <AilegroPanel />}
          {panel === 'instruments' && <InstrumentsPanel />}
          {panel === 'text' && <TextInputPanel />}
          {panel === 'properties' && <PropertiesPanel />}
        </div>
      )}
    </aside>
  );
}
