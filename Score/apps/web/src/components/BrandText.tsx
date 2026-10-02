import { Fragment } from 'react';

/**
 * Renders text with every "AIlegro" marked up so the capital I is distinguishable from an l
 * (they look identical in most sans-serif UI fonts).
 */
export function BrandText({ text }: { text: string }) {
  const parts = text.split('AIlegro');
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              <span className="brand-ai">AI</span>legro
            </>
          )}
          {part}
        </Fragment>
      ))}
    </>
  );
}
