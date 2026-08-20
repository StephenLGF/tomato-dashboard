export function TopLoadingBar({ label = "加载中" }: { label?: string }) {
  return (
    <div className="top-loading-bar" role="progressbar" aria-label={label} aria-valuetext={label}>
      <span />
    </div>
  );
}
