export default function ScoreStars({ value }) {
  const n = Math.min(5, Math.max(1, Number(value) || 3));
  const percent = (n / 5) * 100;
  return (
    <span className="stamina" title={`LLM 예측 체류 스테미나 ${n}/5`}>
      <span className="stamina-bar">
        <span className="stamina-fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="stamina-label">{n}/5</span>
    </span>
  );
}
