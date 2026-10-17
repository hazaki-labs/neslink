//! wasm-bindgen wrapper around tetanes-core, shaped like `EmulatorCore` in `@neslink/core`.
//!
//! Frame and audio buffers are exposed as pointers into wasm memory so the
//! worker can read them without a copy per frame.

use tetanes_core::{
    control_deck::{Config, ControlDeck},
    input::{JoypadBtnState, Player},
    memory::RamState,
    prelude::{NesRegion, ResetKind},
    video::{Frame, VideoFilter},
};
use wasm_bindgen::prelude::*;

const PLAYERS: [Player; 2] = [Player::One, Player::Two];

#[wasm_bindgen]
pub struct Nes {
    deck: ControlDeck,
    frame: Box<[u8; Frame::SIZE]>,
    audio: Vec<f32>,
    state: Vec<u8>,
}

#[wasm_bindgen]
impl Nes {
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Nes {
        let mut cfg = Config::default();
        // Netplay needs every machine to boot identically, so no random RAM.
        cfg.ram_state = RamState::AllZeros;
        // The worker paces frames at NTSC rate; PAL timing is not supported yet.
        cfg.region = NesRegion::Ntsc;
        // Save files are handled by the web app (IndexedDB), not by the core.
        cfg.sram_dir = None;
        // Straight palette colors. The default NTSC composite filter mutes and blurs them.
        cfg.filter = VideoFilter::Pixellate;
        cfg.clear_audio_on_clock = false;
        let mut deck = ControlDeck::with_config(cfg);
        deck.set_sample_rate(sample_rate);
        Nes {
            deck,
            // The filter only writes RGB, so alpha has to start opaque.
            frame: Box::new([0xFF; Frame::SIZE]),
            audio: Vec::new(),
            state: Vec::new(),
        }
    }

    #[wasm_bindgen(js_name = loadRom)]
    pub fn load_rom(&mut self, name: &str, rom: &[u8]) -> Result<(), JsError> {
        let mut reader = rom;
        self.deck.load_rom(name, &mut reader)?;
        self.deck.clear_audio_samples();
        Ok(())
    }

    pub fn reset(&mut self) {
        self.deck.reset(ResetKind::Soft);
    }

    /// Runs one frame. `p1`/`p2` are button masks in NES shift-register order.
    #[wasm_bindgen(js_name = runFrame)]
    pub fn run_frame(&mut self, p1: u8, p2: u8) -> Result<(), JsError> {
        for (player, mask) in PLAYERS.into_iter().zip([p1, p2]) {
            self.deck.joypad_mut(player).buttons = JoypadBtnState::from_bits_truncate(mask.into());
        }
        // At the default 1x speed one call is exactly one NES frame.
        let _ = self.deck.clock_frame()?;
        Ok(())
    }

    /// Renders the last frame as RGBA into an internal buffer and returns its address.
    #[wasm_bindgen(js_name = framePtr)]
    pub fn frame_ptr(&mut self) -> *const u8 {
        self.deck.frame_buffer_into(&mut self.frame);
        self.frame.as_ptr()
    }

    /// Moves pending mono samples into an internal buffer; returns how many there are.
    /// Read them from [`Nes::audio_ptr`] before the next call.
    #[wasm_bindgen(js_name = drainAudio)]
    pub fn drain_audio(&mut self) -> usize {
        self.audio.clear();
        self.audio.extend_from_slice(self.deck.audio_samples());
        self.deck.clear_audio_samples();
        self.audio.len()
    }

    #[wasm_bindgen(js_name = audioPtr)]
    pub fn audio_ptr(&self) -> *const f32 {
        self.audio.as_ptr()
    }

    /// Serializes the console into an internal buffer; returns its length.
    /// Read it from [`Nes::state_ptr`]. Uncompressed, so it is fast enough for rollback.
    #[wasm_bindgen(js_name = saveState)]
    pub fn save_state(&mut self) -> Result<usize, JsError> {
        let len = self.deck.serialized_state_len()?;
        self.state.resize(len, 0);
        Ok(self.deck.serialize_state_into(&mut self.state)?)
    }

    #[wasm_bindgen(js_name = statePtr)]
    pub fn state_ptr(&self) -> *const u8 {
        self.state.as_ptr()
    }

    #[wasm_bindgen(js_name = loadState)]
    pub fn load_state(&mut self, state: &[u8]) -> Result<(), JsError> {
        self.deck.deserialize_state(state)?;
        Ok(())
    }
}
