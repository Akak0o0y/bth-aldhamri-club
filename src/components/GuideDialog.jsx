import { useState } from 'react';
import { Check, Copy, ExternalLink, Server, Star } from 'lucide-react';
import { soundFX } from '../services/soundEffects';
import Dialog from './Dialog';

// Star counts checked on GitHub, Oct 2026.
const SERVERS = [
  {
    id: 'mediamtx',
    name: 'MediaMTX',
    repo: 'bluenviron/mediamtx',
    stars: '20.4k',
    lang: 'Go',
    tag: 'موصى به',
    facts: [
      ['التأخير', 'أقل من ثانية — WebRTC من الطرفين'],
      ['حمل السيرفر', 'يمرر البث بدون إعادة ترميز'],
      ['التشغيل', 'ملف واحد، بدون قاعدة بيانات'],
    ],
    why: 'يستقبل البث من OBS أو من هذا الموقع عبر WHIP، ويوزعه على المشاهدين عبر WHEP كما هو، بدون إعادة ترميز. لذلك يبقى حمل السيرفر شبه معدوم حتى بدقة 4K، ويعمل على جهاز متواضع أو سيرفر رخيص.',
  },
  {
    id: 'broadcastbox',
    name: 'Broadcast Box',
    repo: 'Glimesh/broadcast-box',
    stars: '2.3k',
    lang: 'Go',
    tag: 'الأبسط',
    facts: [
      ['التأخير', 'أقل من ثانية'],
      ['الفكرة', 'بث من OBS للأصدقاء'],
      ['التشغيل', 'Docker أو ملف واحد'],
    ],
    why: 'مصمم لنفس فكرة المجلس تماماً: بث من OBS بـ WHIP لمجموعة أصدقاء بتأخير أقل من ثانية. واجهته محدودة، لكن هذا الموقع يتصل بأي سيرفر يدعم WHEP.',
  },
  {
    id: 'livekit',
    name: 'LiveKit',
    repo: 'livekit/livekit',
    stars: '21.5k',
    lang: 'Go',
    tag: 'للغرف الكبيرة',
    facts: [
      ['البنية', 'WebRTC SFU كامل'],
      ['ميزة', 'Simulcast وعدة متحدثين'],
      ['التكلفة', 'إعداد أثقل وSDK خاص'],
    ],
    why: 'الأقوى عندما يحتاج المجلس عدة كاميرات ومحادثة صوتية جماعية حقيقية، مع جودات متعددة يختارها كل مشاهد حسب سرعته. يحتاج SDK خاص وإعداداً أكثر من MediaMTX.',
  },
  {
    id: 'live777',
    name: 'Live777',
    repo: 'binbat/live777',
    stars: '311',
    lang: 'Rust',
    tag: 'الأخف',
    facts: [
      ['البنية', 'SFU بسيط بلغة Rust'],
      ['البروتوكول', 'WHIP / WHEP فقط'],
      ['الاستهلاك', 'منخفض جداً'],
    ],
    why: 'سيرفر WHIP/WHEP صغير جداً بلغة Rust. منه أخذنا فكرة إلغاء المخزن المؤقت عند المشاهد (jitterBufferTarget = 0) لتقليل التأخير.',
  },
];

const MEDIAMTX_YML = `# mediamtx.yml — مجلس ظمرة: أقل تأخير وأقل استهلاك
logLevel: warn

# أطفئ ما لا نحتاجه لتوفير الموارد
rtsp: no
rtmp: no
hls: no
srt: no

webrtc: yes
webrtcAddress: :8889
webrtcLocalUDPAddress: :8189
webrtcAllowOrigins: ['*']
# ضع هنا IP العام أو الدومين لكي يصل الأصدقاء من خارج شبكتك
webrtcAdditionalHosts: []
webrtcICEServers2:
  - url: stun:stun.l.google.com:19302

paths:
  majlis:
`;

export default function GuideDialog({ onClose }) {
  const [active, setActive] = useState('mediamtx');
  const [copied, setCopied] = useState(false);
  const server = SERVERS.find((s) => s.id === active);

  const copyYml = async () => {
    try {
      await navigator.clipboard.writeText(MEDIAMTX_YML);
      soundFX.playChatNotification();
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked
    }
  };

  return (
    <Dialog
      title="سيرفرات البث بدون تأخير"
      subtitle="مشاريع مفتوحة المصدر تعمل مع المجلس عبر WHIP / WHEP"
      icon={Server}
      size="lg"
      onClose={onClose}
    >
      <div className="guide-tabs" role="tablist">
        {SERVERS.map((s) => (
          <button key={s.id} role="tab" aria-selected={active === s.id} className="guide-tab" onClick={() => setActive(s.id)}>
            <strong>{s.name}</strong>
            <span>
              <Star size={11} />
              <span className="num">{s.stars}</span> · {s.tag}
            </span>
          </button>
        ))}
      </div>

      <div className="guide">
        <div className="guide__facts">
          {server.facts.map(([k, v]) => (
            <div key={k} className="fact">
              <span>{k}</span>
              <strong>{v}</strong>
            </div>
          ))}
        </div>
        <p className="guide__why">{server.why}</p>
        <a className="guide__repo" href={`https://github.com/${server.repo}`} target="_blank" rel="noreferrer">
          <span className="mono">github.com/{server.repo}</span>
          <span className="faint">{server.lang}</span>
          <ExternalLink size={14} />
        </a>

        {active === 'mediamtx' && (
          <>
            <div className="code">
              <div className="code__head">
                <span className="mono">mediamtx.yml</span>
                <button className="btn btn--sm" onClick={copyYml}>
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? 'تم النسخ' : 'نسخ'}
                </button>
              </div>
              <pre className="code__body" dir="ltr">
                {MEDIAMTX_YML}
              </pre>
            </div>

            <ol className="steps">
              <li>
                حمّل MediaMTX من صفحة الإصدارات في GitHub، وضع <code>mediamtx.yml</code> بجانبه ثم شغّله.
              </li>
              <li>
                في إعدادات المجلس اكتب عنوان السيرفر، مثل <code>http://192.168.1.10:8889</code>، واسم الغرفة <code>majlis</code>.
              </li>
              <li>
                اضغط <b>ابدأ البث</b> من المتصفح، أو من OBS بخدمة <b>WHIP</b>.
              </li>
              <li>
                للأصدقاء خارج شبكتك: افتح المنفذين <code>8889/TCP</code> و <code>8189/UDP</code> في الراوتر، وأضف IP العام في
                <code>webrtcAdditionalHosts</code>.
              </li>
              <li>
                إذا كان الموقع على <code>https</code> فيجب أن يكون السيرفر على <code>https</code> أيضاً، عبر دومين مع Caddy أو nginx.
              </li>
            </ol>
          </>
        )}
      </div>
    </Dialog>
  );
}
