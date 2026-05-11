use egui::{Color32, FontData, FontDefinitions, FontFamily, Margin, Rounding, Stroke, Vec2};

#[derive(Clone, Copy)]
pub struct ThemeTokens {
    pub dark: bool,
    pub bg: Color32,
    pub app_bg: Color32,
    pub sidebar_bg: Color32,
    pub surface: Color32,
    pub surface_2: Color32,
    pub surface_3: Color32,
    pub surface_hover: Color32,
    pub surface_selected: Color32,
    pub surface_low: Color32,
    pub surface_high: Color32,
    pub border: Color32,
    pub border_strong: Color32,
    pub text: Color32,
    pub muted: Color32,
    pub muted_strong: Color32,
    pub accent: Color32,
    pub accent_text: Color32,
    pub accent_soft: Color32,
    pub success: Color32,
    pub warning: Color32,
    pub warning_bg: Color32,
    pub danger: Color32,
    pub danger_bg: Color32,
    pub danger_border: Color32,
    pub radius: f32,
    pub radius_sm: f32,
    pub radius_lg: f32,
    pub sidebar_width: f32,
}

impl ThemeTokens {
    pub fn dark() -> Self {
        Self {
            dark: true,
            bg: rgb(0x05, 0x05, 0x05),
            app_bg: rgb(0x08, 0x08, 0x08),
            sidebar_bg: rgb(0x0b, 0x0b, 0x0c),
            surface: rgb(0x11, 0x11, 0x13),
            surface_2: rgb(0x15, 0x15, 0x18),
            surface_3: rgb(0x1a, 0x1a, 0x1e),
            surface_hover: rgb(0x20, 0x20, 0x24),
            surface_selected: rgb(0x1f, 0x1f, 0x23),
            surface_low: rgb(0x0d, 0x0d, 0x0f),
            surface_high: rgb(0x18, 0x18, 0x1b),
            border: rgb(0x27, 0x27, 0x2a),
            border_strong: rgb(0x3f, 0x3f, 0x46),
            text: rgb(0xf4, 0xf4, 0xf5),
            muted: rgb(0xa1, 0xa1, 0xaa),
            muted_strong: rgb(0xd4, 0xd4, 0xd8),
            accent: rgb(0xf4, 0xf4, 0xf5),
            accent_text: rgb(0x09, 0x09, 0x0b),
            accent_soft: rgb(0x1c, 0x1c, 0x1f),
            success: rgb(0xd8, 0xd3, 0xc4),
            warning: rgb(0xd6, 0xb7, 0x7a),
            warning_bg: rgb(0x22, 0x1b, 0x0d),
            danger: rgb(0xff, 0xb4, 0xa8),
            danger_bg: rgb(0x24, 0x12, 0x10),
            danger_border: rgb(0x7a, 0x30, 0x28),
            radius: 10.0,
            radius_sm: 8.0,
            radius_lg: 16.0,
            sidebar_width: 300.0,
        }
    }

    pub fn light() -> Self {
        Self {
            dark: false,
            bg: rgb(0xf7, 0xf7, 0xf8),
            app_bg: rgb(0xff, 0xff, 0xff),
            sidebar_bg: rgb(0xf2, 0xf2, 0xf3),
            surface: rgb(0xff, 0xff, 0xff),
            surface_2: rgb(0xf4, 0xf4, 0xf5),
            surface_3: rgb(0xee, 0xee, 0xef),
            surface_hover: rgb(0xe9, 0xe9, 0xeb),
            surface_selected: rgb(0xe4, 0xe4, 0xe7),
            surface_low: rgb(0xfa, 0xfa, 0xfa),
            surface_high: rgb(0xf4, 0xf4, 0xf5),
            border: rgb(0xd4, 0xd4, 0xd8),
            border_strong: rgb(0xa1, 0xa1, 0xaa),
            text: rgb(0x18, 0x18, 0x1b),
            muted: rgb(0x71, 0x71, 0x7a),
            muted_strong: rgb(0x3f, 0x3f, 0x46),
            accent: rgb(0x18, 0x18, 0x1b),
            accent_text: rgb(0xff, 0xff, 0xff),
            accent_soft: rgb(0xed, 0xed, 0xf0),
            success: rgb(0x57, 0x53, 0x4e),
            warning: rgb(0x8a, 0x5a, 0x12),
            warning_bg: rgb(0xff, 0xf7, 0xed),
            danger: rgb(0xb4, 0x23, 0x18),
            danger_bg: rgb(0xff, 0xf1, 0xf0),
            danger_border: rgb(0xf5, 0xb5, 0xae),
            radius: 10.0,
            radius_sm: 8.0,
            radius_lg: 16.0,
            sidebar_width: 300.0,
        }
    }

    pub fn panel_frame(self) -> egui::Frame {
        egui::Frame::none()
            .fill(self.surface)
            .stroke(Stroke::new(1.0, self.border))
            .rounding(Rounding::same(self.radius))
            .inner_margin(Margin::same(14.0))
    }

    pub fn subtle_frame(self) -> egui::Frame {
        egui::Frame::none()
            .fill(self.surface_low)
            .stroke(Stroke::new(1.0, self.border))
            .rounding(Rounding::same(self.radius_sm))
            .inner_margin(Margin::same(10.0))
    }

    pub fn card_frame(self, selected: bool) -> egui::Frame {
        egui::Frame::none()
            .fill(if selected { self.surface_selected } else { self.surface })
            .stroke(Stroke::new(1.0, if selected { self.border_strong } else { self.border }))
            .rounding(Rounding::same(self.radius))
            .inner_margin(Margin::symmetric(12.0, 10.0))
    }

    pub fn bubble_frame(self, from_user: bool) -> egui::Frame {
        let fill = if from_user { self.surface_2 } else { self.surface };
        let border = if from_user { self.border_strong } else { self.border };
        egui::Frame::none()
            .fill(fill)
            .stroke(Stroke::new(1.0, border))
            .rounding(Rounding::same(self.radius))
            .inner_margin(Margin::symmetric(14.0, 12.0))
    }
}

pub fn apply_context_style(ctx: &egui::Context, tokens: ThemeTokens) {
    install_system_fonts(ctx);
    let mut visuals = if tokens.dark { egui::Visuals::dark() } else { egui::Visuals::light() };
    visuals.window_fill = tokens.surface;
    visuals.panel_fill = tokens.app_bg;
    visuals.extreme_bg_color = tokens.bg;
    visuals.override_text_color = Some(tokens.text);
    visuals.selection.bg_fill = tokens.surface_selected;
    visuals.selection.stroke = Stroke::new(1.0, tokens.border_strong);
    visuals.widgets.noninteractive.bg_fill = tokens.surface;
    visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0, tokens.text);
    visuals.widgets.inactive.bg_fill = tokens.surface_2;
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, tokens.muted_strong);
    visuals.widgets.hovered.bg_fill = tokens.surface_hover;
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, tokens.text);
    visuals.widgets.active.bg_fill = tokens.surface_selected;
    visuals.widgets.active.fg_stroke = Stroke::new(1.0, tokens.text);
    ctx.set_visuals(visuals);

    let mut style = (*ctx.style()).clone();
    style.spacing.item_spacing = Vec2::new(8.0, 8.0);
    style.spacing.button_padding = Vec2::new(12.0, 8.0);
    style.spacing.menu_margin = Margin::same(8.0);
    style.visuals = ctx.style().visuals.clone();
    ctx.set_style(style);
}

fn install_system_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();
    let candidates = [
        "C:\\Windows\\Fonts\\msyh.ttc",
        "C:\\Windows\\Fonts\\msyh.ttf",
        "C:\\Windows\\Fonts\\simhei.ttf",
        "C:\\Windows\\Fonts\\seguisym.ttf",
    ];
    for path in candidates {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        fonts.font_data.insert("system_cjk".to_string(), FontData::from_owned(bytes));
        fonts
            .families
            .entry(FontFamily::Proportional)
            .or_default()
            .insert(0, "system_cjk".to_string());
        fonts.families.entry(FontFamily::Monospace).or_default().push("system_cjk".to_string());
        ctx.set_fonts(fonts);
        return;
    }
}

pub fn rgb(r: u8, g: u8, b: u8) -> Color32 {
    Color32::from_rgb(r, g, b)
}

pub fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color32 {
    Color32::from_rgba_unmultiplied(r, g, b, a)
}
