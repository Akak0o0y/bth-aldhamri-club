// Dhamri's HEVC transport: FFmpeg RTP on loopback -> encrypted WebRTC/WHIP.
// Video is forwarded without decoding, scaling, or re-encoding.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

var outputMu sync.Mutex

func emit(event any) {
	outputMu.Lock()
	defer outputMu.Unlock()
	_ = json.NewEncoder(os.Stdout).Encode(event)
}

func localEndpoint(raw string) (*url.URL, error) {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "http" || target.Hostname() != "127.0.0.1" || target.Port() == "" || target.User != nil || target.Fragment != "" {
		return nil, errors.New("the bridge requires the companion's loopback signaling endpoint")
	}
	return target, nil
}

func makeTrack(pc *webrtc.PeerConnection, capability webrtc.RTPCodecCapability, id string) (*webrtc.TrackLocalStaticRTP, *net.UDPConn, error) {
	track, err := webrtc.NewTrackLocalStaticRTP(capability, id, "dhamri")
	if err != nil {
		return nil, nil, err
	}
	sender, err := pc.AddTrack(track)
	if err != nil {
		return nil, nil, err
	}
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, nil, err
	}
	// Hardware encoders can emit a keyframe as a short burst of hundreds of
	// packets. Reserve bounded headroom so loopback does not lose fragments
	// while encryption is scheduled; this is under 3 MiB for video plus audio.
	readBuffer := 262144
	if capability.MimeType == webrtc.MimeTypeH265 {
		readBuffer = 2 * 1024 * 1024
	}
	if err := socket.SetReadBuffer(readBuffer); err != nil {
		socket.Close()
		return nil, nil, errors.New("could not reserve the local RTP receive buffer")
	}
	// Drain RTCP so Pion's bounded retransmission/NACK interceptors run.
	go func() {
		buffer := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buffer); err != nil {
				return
			}
		}
	}()
	return track, socket, nil
}

func forward(socket *net.UDPConn, track *webrtc.TrackLocalStaticRTP, expected uint8, failed chan<- error) {
	buffer := make([]byte, 1600)
	packet := &rtp.Packet{}
	for {
		n, _, err := socket.ReadFromUDP(buffer)
		if err != nil {
			return
		}
		if err := packet.Unmarshal(buffer[:n]); err != nil || packet.PayloadType != expected {
			continue
		}
		// TrackLocalStaticRTP rewrites only SSRC/payload type for negotiation.
		if err := track.WriteRTP(packet); err != nil {
			select {
			case failed <- errors.New("media transport stopped"):
			default:
			}
			return
		}
	}
}

func connect(ctx context.Context, target *url.URL, audio bool, level int) error {
	engine := &webrtc.MediaEngine{}
	video := webrtc.RTPCodecCapability{
		MimeType: webrtc.MimeTypeH265, ClockRate: 90000,
		SDPFmtpLine:  fmt.Sprintf("profile-id=1;tier-flag=0;level-id=%d;tx-mode=SRST", level),
		RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}},
	}
	opus := webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}
	if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: video, PayloadType: 96}, webrtc.RTPCodecTypeVideo); err != nil {
		return err
	}
	if audio {
		if err := engine.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: opus, PayloadType: 111}, webrtc.RTPCodecTypeAudio); err != nil {
			return err
		}
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(engine, registry); err != nil {
		return err
	}
	setting := webrtc.SettingEngine{}
	setting.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	setting.SetIncludeLoopbackCandidate(true)
	setting.SetICETimeouts(5*time.Second, 10*time.Second, 2*time.Second)
	api := webrtc.NewAPI(webrtc.WithMediaEngine(engine), webrtc.WithInterceptorRegistry(registry), webrtc.WithSettingEngine(setting))
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	defer pc.Close()
	ready := make(chan struct{})
	failed := make(chan error, 1)
	var once sync.Once
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			once.Do(func() { close(ready) })
		}
		if state == webrtc.PeerConnectionStateFailed {
			select {
			case failed <- errors.New("WebRTC connection failed; check UDP or Tailscale reachability"):
			default:
			}
		}
	})
	videoTrack, videoSocket, err := makeTrack(pc, video, "video")
	if err != nil {
		return err
	}
	defer videoSocket.Close()
	audioPort := 0
	var audioTrack *webrtc.TrackLocalStaticRTP
	var audioSocket *net.UDPConn
	if audio {
		audioTrack, audioSocket, err = makeTrack(pc, opus, "audio")
		if err != nil {
			return err
		}
		defer audioSocket.Close()
		audioPort = audioSocket.LocalAddr().(*net.UDPAddr).Port
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	select {
	case <-gathered:
	case <-ctx.Done():
		return nil
	case <-time.After(8 * time.Second):
		return errors.New("ICE gathering timed out")
	}
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), strings.NewReader(pc.LocalDescription().SDP))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/sdp")
	response, err := client.Do(request)
	if err != nil {
		return errors.New("WHIP signaling request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		return fmt.Errorf("WHIP rejected HEVC (HTTP %d)", response.StatusCode)
	}
	resource, err := response.Location()
	if err != nil || resource.Scheme != target.Scheme || resource.Host != target.Host || resource.User != nil {
		return errors.New("invalid WHIP session location")
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(cleanup, http.MethodDelete, resource.String(), nil)
		if res, err := client.Do(req); err == nil {
			res.Body.Close()
		}
	}()
	sdp, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(sdp) > 65536 {
		return errors.New("invalid SDP response")
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: string(sdp)}); err != nil {
		return errors.New("server did not negotiate HEVC/Opus")
	}
	select {
	case <-ready:
	case err := <-failed:
		return err
	case <-ctx.Done():
		return nil
	case <-time.After(15 * time.Second):
		return errors.New("UDP handshake timed out; the server must support HEVC over WebRTC")
	}
	go forward(videoSocket, videoTrack, 96, failed)
	if audio {
		go forward(audioSocket, audioTrack, 111, failed)
	}
	emit(map[string]any{"event": "ready", "codec": "H265", "videoPort": videoSocket.LocalAddr().(*net.UDPAddr).Port, "audioPort": audioPort})
	select {
	case <-ctx.Done():
		return nil
	case err := <-failed:
		return err
	}
}

func main() {
	endpoint := flag.String("url", "", "Companion's loopback WHIP endpoint")
	audio := flag.Bool("audio", false, "Also forward Opus RTP")
	level := flag.Int("level", 150, "HEVC level-id: 150, 153 or 156")
	flag.Parse()
	if *level != 150 && *level != 153 && *level != 156 {
		emit(map[string]string{"event": "error", "message": "unsupported HEVC level"})
		os.Exit(1)
	}
	target, err := localEndpoint(*endpoint)
	if err != nil {
		emit(map[string]string{"event": "error", "message": err.Error()})
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			if strings.TrimSpace(scanner.Text()) == "q" {
				break
			}
		}
		cancel() // Parent exit / stdin EOF also releases UDP sockets and WHIP.
	}()
	if err := connect(ctx, target, *audio, *level); err != nil {
		emit(map[string]string{"event": "error", "message": err.Error()})
		os.Exit(1)
	}
}
