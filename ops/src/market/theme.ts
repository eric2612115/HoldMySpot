import { studioTheme } from 'ag-studio';

/** AG Studio themed to the HoldMySpot palette: grape accent, mint canvas, rounded widgets, Fredoka titles. */
const PALETTE = ['#5B4CF0', '#FFC53D', '#2FB37A', '#F0476A', '#4CC9F0', '#A78BFA', '#FFA94D', '#7E839D'];

export const hmsStudioTheme = studioTheme.withParams({
  accentColor: '#5B4CF0',
  backgroundColor: '#FFFFFF',
  foregroundColor: '#23253A',
  textColor: '#23253A',
  subtleTextColor: '#7E839D',
  borderColor: '#E6E7F1',
  fontFamily: "'Figtree Variable', system-ui, sans-serif",
  fontSize: 13,
  borderRadius: 10,
  rowHoverColor: '#F6F4FF',
  studioCanvasBackgroundColor: '#EEF4E6',
  studioCanvasFontFamily: "'Figtree Variable', system-ui, sans-serif",
  studioWidgetBackgroundColor: '#FFFFFF',
  studioWidgetBorderRadius: 18,
  studioWidgetTitleFontFamily: "'Fredoka Variable', system-ui, sans-serif",
  studioWidgetTitleFontSize: 16,
  studioWidgetTitleFontWeight: 600,
  studioWidgetTitleTextColor: '#23253A',
  studioWidgetSubtitleFontFamily: "'Figtree Variable', system-ui, sans-serif",
  studioWidgetSubtitleFontSize: 11.5,
  studioWidgetSubtitleTextColor: '#7E839D',
  studioWidgetPadding: 10,
  studioWidgetBorder: { color: '#E6E7F1', width: 1 },
  studioWidgetShadow: '0 1px 2px rgba(35, 30, 90, 0.05), 0 4px 14px rgba(35, 30, 90, 0.06)',
  studioPanelHeaderFontFamily: "'Fredoka Variable', system-ui, sans-serif",
  studioAiPanelWidth: 372,
  chartFontFamily: "'Figtree Variable', system-ui, sans-serif",
  chartTitleFontFamily: "'Fredoka Variable', system-ui, sans-serif",
  ...Object.fromEntries(PALETTE.flatMap((c, i) => [[`chartPaletteFills${i + 1}Color`, c], [`chartPaletteStrokes${i + 1}Color`, c]])),
} as never);
