#pragma once

#include <array>
#include <cstddef>
#include <cstdint>

namespace baoyan::edge {

// All IDs belong to one controller lifetime. Adapters must also scope traffic to
// the device boot and authenticated connection; these counters are not secrets.
struct TurnToken {
  std::uint64_t connection{0};
  std::uint64_t session{0};
  std::uint64_t turn{0};
};
constexpr bool operator==(TurnToken a, TurnToken b) noexcept {
  return a.connection == b.connection && a.session == b.session && a.turn == b.turn;
}
constexpr bool operator!=(TurnToken a, TurnToken b) noexcept { return !(a == b); }

struct CaptureToken {
  std::uint64_t connection{0};
  std::uint64_t session{0};
  std::uint64_t capture{0};
};
constexpr bool operator==(CaptureToken a, CaptureToken b) noexcept {
  return a.connection == b.connection && a.session == b.session && a.capture == b.capture;
}
constexpr bool operator!=(CaptureToken a, CaptureToken b) noexcept { return !(a == b); }

enum class State {
  Offline, Idle, Connecting, StartingCapture, Listening,
  WaitingReply, ReplyQueued, Speaking, Stopped, Muted, Fault
};
enum class Reason {
  None, ExplicitStop, Completed, NetworkLost, ConnectionReplaced,
  PhysicalMute, AdapterFailure, QualifiedSpeech, CounterExhausted
};
enum class SpeechEvidence {
  UnverifiedActivity,
  NearEndSpeech,           // Speech classifier output; not sufficient over playback.
  AecQualifiedNearEnd     // Only from a board-validated AEC + near-end detector.
};
enum class ActionKind {
  OpenSession, CloseSession, StartCapture, StopCapture,
  BeginTurn, UtteranceFinished, QueueAudioFrame, StopPlayback,
  CancelResponse, SetVolume, SetHardwareMute, SetIndicator
};

struct Action {
  ActionKind kind{ActionKind::SetIndicator};
  TurnToken turn{};
  CaptureToken capture{};
  std::uint64_t frame_sequence{0};
  int value{0};
  State state{State::Offline};
  Reason reason{Reason::None};
  std::uint64_t utterance_id{0};
};

// A transition has at most 8 effects; fixed storage keeps the core heap-free.
struct Actions {
  static constexpr std::size_t capacity = 12;
  std::array<Action, capacity> items{};
  std::size_t size{0};
  const Action* begin() const noexcept { return items.data(); }
  const Action* end() const noexcept { return items.data() + size; }
};

struct Config {
  // Default is half-duplex. Setting this flag is NOT evidence that AEC works.
  // Enable only after the actual board/microphone/speaker path passes testing.
  bool board_duplex_validated{false};
  int initial_volume{50};
};

struct Status {
  State state{State::Offline};
  bool network_ready{false};
  bool physical_mute{false};
  bool session_open{false};
  bool capture_requested{false};
  bool capture_active{false};
  bool playback_active{false};
  int volume{50};
  std::uint64_t control_epoch{1}; // Snapshot when a local wake/start is observed.
  std::uint64_t utterance_id{0};  // Accepted current acoustic utterance; 0 when none.
  TurnToken turn{};
  CaptureToken capture{};
};

// Single-threaded deterministic control only: no microphone, PCM processing,
// networking, authentication, clock, storage, or model implementation.
// Serialize events in one task; apply effects in returned order.
class Controller {
 public:
  explicit Controller(Config config = {}) noexcept;

  const Status& status() const noexcept { return status_; }
  TurnToken captureTarget(CaptureToken token) const noexcept;
  bool mayUpload(CaptureToken token, TurnToken captured_turn) const noexcept;
  Actions networkReady(std::uint64_t connection_id) noexcept;
  Actions networkLost(std::uint64_t connection_id) noexcept;
  Actions wake(std::uint64_t observed_control_epoch) noexcept;
  Actions sessionOpened(TurnToken token) noexcept; // Authenticated gateway ACK.
  Actions captureStarted(CaptureToken token) noexcept;
  // Adapter assigns a nonzero increasing ID at acoustic onset, not delivery.
  Actions speechStarted(CaptureToken token, std::uint64_t utterance_id,
                        SpeechEvidence evidence) noexcept;
  Actions utteranceEnded(CaptureToken token, std::uint64_t utterance_id) noexcept;
  Actions replyStarted(TurnToken token) noexcept;
  Actions audioFrame(TurnToken token, std::uint64_t sequence) noexcept;
  Actions playbackStarted(TurnToken token) noexcept;
  Actions replyEnded(TurnToken token) noexcept;  // Network generation complete.
  Actions playbackDrained(TurnToken token) noexcept; // Actual local queue empty.
  Actions stop() noexcept;
  Actions end() noexcept;
  Actions setPhysicalMute(bool muted) noexcept;
  Actions setVolume(int percent) noexcept;
  Actions adapterFailed(TurnToken token) noexcept;

 private:
  Config config_;
  Status status_{};
  std::uint64_t highest_connection_{0};
  std::uint64_t session_counter_{0};
  std::uint64_t capture_counter_{0};
  std::uint64_t next_frame_{0};
  std::uint64_t highest_utterance_id_{0};
  bool session_requested_{false};
  bool utterance_has_speech_{false};
  bool reply_open_{false};
  bool reply_input_done_{false};
  bool frame_queued_{false};
  bool wake_locked_{false};

  bool current(TurnToken token) const noexcept;
  bool current(CaptureToken token) const noexcept;
  bool responsePending() const noexcept;
  void effect(Actions&, ActionKind, Reason = Reason::None,
              TurnToken = {}, CaptureToken = {}, int value = 0,
              std::uint64_t sequence = 0, std::uint64_t utterance_id = 0) noexcept;
  void indicator(Actions&, State) noexcept;
  void requestCapture(Actions&) noexcept;
  void releaseCapture(Actions&, Reason) noexcept;
  void releaseSession(Actions&, Reason) noexcept;
  bool nextTurn(Actions&, Reason) noexcept;
  void resetReply() noexcept;
  void advanceControlEpoch() noexcept;
};

const char* name(State) noexcept;
const char* name(ActionKind) noexcept;
const char* name(Reason) noexcept;

}  // namespace baoyan::edge
