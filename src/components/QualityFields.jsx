// The broadcast settings form, shared by "go live" and the hold panel (where
// the streamer changes quality before continuing).
import { Camera, Cpu, FileText, Gamepad2, LoaderCircle, SwitchCamera } from 'lucide-react';
import { gbPerViewerHour, perViewerMbps, REFERENCE_SERVER_MBPS, viewerCapacity } from '../stream/capacity';
import { VIDEO_CODECS } from '../stream/codecs';
import { PRESETS, presetKbps } from '../stream/controller';
import { audioKbpsFor, HAS_FACING, SOURCES, SUPPORT } from './qualityDraft';

export default function QualityFields({ draft, screenGuide }) {
  const { source, preset, fps, codecId, probes, bitrate } = draft;
  const autoProbe = probes?.find((p) => p.id === draft.autoCodec);
  const audioKbps = audioKbpsFor(source);
  const uploadMbps = ((bitrate + audioKbps) * 1.5) / 1000;
  const each = perViewerMbps(bitrate, audioKbps);

  return (
    <>
      <section className="studio__block">
        <span className="label">المصدر</span>
        <div className="seg seg--wrap">
          {SOURCES.map(({ id, label, icon: Icon }) => (
            <button key={id} className="seg__opt" aria-pressed={source === id} onClick={() => draft.setSource(id)}>
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>
        {!SUPPORT.screen && source !== 'screen' && (
          <p className="hint">هذا الجهاز لا يشارك شاشته من المتصفح؛ اختر «الشاشة أو لعبة» لترى طرق بث شاشته.</p>
        )}
      </section>

      {draft.blocked ? screenGuide : (
        <>
          {source === 'screen' && (
            <section className="studio__block">
              <span className="label">نوع المحتوى</span>
              <div className="seg">
                <button className="seg__opt" aria-pressed={draft.contentHint === 'motion'} onClick={() => draft.setContentHint('motion')}>
                  <Gamepad2 size={16} />
                  ألعاب وأفلام — سلاسة الحركة
                </button>
                <button className="seg__opt" aria-pressed={draft.contentHint === 'detail'} onClick={() => draft.setContentHint('detail')}>
                  <FileText size={16} />
                  شاشة ونصوص — حدة التفاصيل
                </button>
              </div>
              <p className="hint">
                {draft.contentHint === 'motion'
                  ? 'نفضّل سلاسة الحركة؛ قد تنخفض الدقة أو الإطارات إذا لم يكفِ الجهاز أو الاتصال.'
                  : 'نفضّل التفاصيل؛ قد تنخفض الإطارات عند ضغط الجهاز أو الاتصال.'}
              </p>
            </section>
          )}

          {source === 'camera' && HAS_FACING && (
            <section className="studio__block">
              <span className="label">الكاميرا</span>
              <div className="seg">
                <button className="seg__opt" aria-pressed={draft.facing === 'user'} onClick={() => draft.setFacing('user')}>
                  <SwitchCamera size={16} />
                  الأمامية
                </button>
                <button className="seg__opt" aria-pressed={draft.facing === 'environment'} onClick={() => draft.setFacing('environment')}>
                  <Camera size={16} />
                  الخلفية
                </button>
              </div>
              <p className="hint">تقدر تبدّل الكاميرا أثناء البث أيضاً. كاميرات الجوال والآيباد في المتصفح تعطي غالباً 1080p أو 720p عند 30 إطار.</p>
            </section>
          )}

          <section className="studio__block">
            <div className="studio__row">
              <span className="label">الدقة</span>
              <div className="seg seg--compact" aria-label="معدل الإطارات">
                {[60, 30].map((f) => (
                  <button key={f} className="seg__opt" aria-pressed={fps === f} onClick={() => draft.setFps(f)}>
                    <span className="num">{f}</span> إطار
                  </button>
                ))}
              </div>
            </div>
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p.id} className="preset" aria-pressed={preset.id === p.id} onClick={() => draft.setPresetId(p.id)}>
                  {p.id === '1440' && <span className="preset__badge">جودة عالية</span>}
                  <strong className="num">{p.label}</strong>
                  <span>{p.name}</span>
                  <small className="num">≈ {(presetKbps(p, codecId, fps) / 1000).toFixed(1)} Mbps</small>
                </button>
              ))}
            </div>
            <p className="hint">الهدف {preset.width}×{preset.height} عند {fps} إطار. اختر مصدراً بهذه الدقة؛ فيديو 30 إطار لا يتحول إلى حركة 60 إطار بتكراره.</p>
          </section>

          <section className="studio__block">
            <span className="label">الكودك</span>
            <div className="codecs">
              <button className="codec" aria-pressed={draft.codec === 'auto'} onClick={() => draft.setCodec('auto')}>
                <span className="codec__name">تلقائي</span>
                <span className="codec__note">{probes ? `${autoProbe?.label ?? 'H.264'} — حسب قدرات المتصفح` : 'جارٍ فحص الجودة المحددة…'}</span>
                {probes ? <HwBadge hw={autoProbe?.hw} /> : <LoaderCircle size={14} className="spin" />}
              </button>
              {(probes ?? VIDEO_CODECS).map((c) => (
                <button
                  key={c.id}
                  className="codec"
                  aria-pressed={draft.codec === c.id}
                  disabled={probes ? !c.supported : false}
                  onClick={() => draft.setCodec(c.id)}
                >
                  <span className="codec__name num">{c.label}</span>
                  <span className="codec__note">{c.supported === false ? 'غير مدعوم في هذا المتصفح' : c.note}</span>
                  {probes && c.supported && <HwBadge hw={c.hw} />}
                </button>
              ))}
            </div>
            {draft.selectedProbe?.smooth === false && <p className="settings-warn">المتصفح يتوقع صعوبة في هذه الجودة. شغّل فحص الجهاز قبل البث.</p>}
          </section>

          <section className="studio__block">
            <div className="studio__row">
              <label className="label" htmlFor="studio-bitrate">
                معدل البت
              </label>
              <span className="chip chip--accent num">{(bitrate / 1000).toFixed(1)} Mbps</span>
            </div>
            <input
              id="studio-bitrate"
              type="range"
              className="range"
              min="1000"
              max="30000"
              step="500"
              value={bitrate}
              style={{ '--pct': `${((bitrate - 1000) / 29000) * 100}%` }}
              onChange={(e) => draft.setBitrate(Number(e.target.value))}
            />
            <p className="hint">
              نوصي بسرعة رفع مستقرة ≈ <b className="num">{uploadMbps.toFixed(1)} Mbps</b> مع هامش للاتصال. معدل البت سقف؛ المتصفح يضبط الإرسال حسب المشهد والشبكة.
            </p>
            <p className="hint">
              كل مشاهد يستقبل ≈ <b className="num">{each.toFixed(1)} Mbps</b>، فسيرفر بسرعة <span className="num">{REFERENCE_SERVER_MBPS / 1000}</span> Gbps يخدم نحو{' '}
              <b className="num">{viewerCapacity(REFERENCE_SERVER_MBPS, bitrate, audioKbps)}</b> مشاهد بهذه الجودة (
              <span className="num">{gbPerViewerHour(bitrate, audioKbps).toFixed(1)}</span> GB لكل مشاهد في الساعة). سرعة رفعك لا تتغير مع عدد المشاهدين، ويحتاج كل مشاهد سرعة تنزيل أعلى من ذلك.
            </p>
          </section>
        </>
      )}
    </>
  );
}

function HwBadge({ hw }) {
  if (hw === true) {
    return (
      <span className="chip chip--good codec__hw">
        <Cpu size={12} />
        مرجّح بالعتاد
      </span>
    );
  }
  if (hw === false) return <span className="chip codec__hw">قد يستهلك موارد أكثر</span>;
  return null;
}
