# How many viewers can watch one streamer — كم مشاهد يتحمل البث الواحد

**The short answer:** the streamer's upload does not limit the audience. The media server's upload does. MediaMTX receives one encode and forwards a full copy to every viewer without transcoding. So:

```
viewers ≈ (server upload × 0.8) ÷ (stream bitrate × 1.1)
```

`0.8` leaves a fifth of the link for keyframe bursts and everything else. `1.1` covers RTP/SRTP/UDP headers and retransmissions. The studio shows the same figure live (`src/stream/capacity.js`).

## Viewers per stream (H.264 defaults)

| Stream | Each viewer receives | 480 Mbps server | 1 Gbps | 2 Gbps | 4 Gbps | GB per viewer-hour |
| --- | --- | --- | --- | --- | --- | --- |
| 4K60 screen | 33.1 Mbps | 11 | 24 | 48 | 96 | 14.9 |
| 2K60 screen (studio default) | 22.1 Mbps | 17 | 36 | 72 | 144 | 10.0 |
| 1080p60 screen | 11.1 Mbps | 34 | 71 | 143 | 287 | 5.0 |
| 1080p30 camera (iPad / iPhone default) | 7.2 Mbps | 53 | 110 | 221 | 443 | 3.2 |
| 720p30 camera | 3.7 Mbps | 103 | 216 | 432 | 864 | 1.7 |

Server columns: Oracle lists the `VM.Standard.E2.1.Micro` shape at 480 Mbps and `VM.Standard.A1.Flex` at 1 Gbps per OCPU ([Compute shapes](https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm)). The Gulf server (`server/gulf/setup.sh`) therefore scales with the OCPUs of the instance it runs on. Check the shape in the Oracle console to know which column applies.

## What else limits it

- **Every viewer needs that download speed.** There is no simulcast, so everyone receives the same stream. A viewer on a 10 Mbps connection cannot keep up with a 2K60 stream at 22 Mbps. For a public audience, 1080p30 or 720p30 reaches far more people.
- **Monthly data.** Multiply viewers × hours × the GB column. For example, 50 viewers for 2 hours of 2K60 is about 1 TB. Check the outbound-data allowance on the server's billing page.
- **Server CPU.** Each extra viewer costs MediaMTX one more encryption pass of the stream. Network usually runs out first on these shapes, but measure with real viewers before relying on the larger columns.
- **Chat and presence** run on the separate realtime relay (`server/realtime.js`) and send a few hundred bytes per message, small next to the video.

## Lowering the cost per viewer

- Hold the stream (the **استراحة** button) during breaks: viewers stay connected while the still card costs almost nothing to send.
- Choose AV1 or VP9 when viewers' browsers decode them well. They need less bitrate than H.264 for similar quality, though the gain depends on the content and encoder.
- More viewers than one server can carry needs a second MediaMTX server relaying from the first, or a CDN/SFU service. Neither is set up in this repository.
