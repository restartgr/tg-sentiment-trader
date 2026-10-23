export function SiteHeader({ updatedAt }: { updatedAt: string }) {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="TG Sentiment 首页">
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="brand-copy">
          <strong>signalroom</strong>
          <small>TG SENTIMENT LAB</small>
        </span>
      </a>
      <div className="header-right">
        <span className="mode-pill">
          <span className="live-dot" />
          LOCAL MODE
        </span>
        <span className="header-time">{updatedAt}</span>
      </div>
    </header>
  );
}
