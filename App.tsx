import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet, Text, View, SafeAreaView, ActivityIndicator,
  StatusBar, ScrollView, Animated, TouchableOpacity, Dimensions,
} from 'react-native';
import { ref, onValue, orderByChild, startAt, endAt, query } from 'firebase/database';
import { LineChart } from 'react-native-chart-kit';
import { db } from './firebase';
import BluetoothScreen from './BluetoothScreen';

const { width: SCREEN_W } = Dimensions.get('window');
const CHART_W = SCREEN_W - 72;

// ── Types ─────────────────────────────────────────────────────────────────────
interface SoilReading {
  moisture: number; rawValue: number; timestamp: string; unit: string;
}
interface ChartPoint { time: string; moisture: number; }

// ── Helpers ───────────────────────────────────────────────────────────────────
function getMoistureInfo(m: number) {
  if (m < 20) return { color: '#ef4444', label: 'Rất khô' };
  if (m < 40) return { color: '#f97316', label: 'Khô' };
  if (m < 60) return { color: '#eab308', label: 'Vừa đủ' };
  if (m < 80) return { color: '#84cc16', label: 'Ẩm' };
  return { color: '#22c55e', label: 'Rất ẩm' };
}

function formatTimestamp(ts: string) {
  try {
    return new Date(ts).toLocaleString('vi-VN', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch { return ts; }
}

function getTodayString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function addDays(dateStr: string, days: number) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDisplayDate(dateStr: string) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('vi-VN', {
    weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

// ── Firebase screen ───────────────────────────────────────────────────────────
function FirebaseScreen() {
  const [reading,      setReading]      = useState<SoilReading | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(getTodayString);
  const [chartData,    setChartData]    = useState<ChartPoint[]>([]);
  const [chartLoading, setChartLoading] = useState(true);

  const fadeAnim  = useRef(new Animated.Value(0)).current;
  const flashAnim = useRef(new Animated.Value(1)).current;
  const prevTs    = useRef<string | null>(null);

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 700, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    if (!reading) return;
    if (prevTs.current !== null && prevTs.current !== reading.timestamp) {
      Animated.sequence([
        Animated.timing(flashAnim, { toValue: 0.35, duration: 130, useNativeDriver: true }),
        Animated.timing(flashAnim, { toValue: 1,    duration: 270, useNativeDriver: true }),
      ]).start();
    }
    prevTs.current = reading.timestamp;
  }, [reading?.timestamp]);

  useEffect(() => {
    return onValue(ref(db, '/soil-moisture/latest'),
      (snap) => { const d = snap.val(); if (d) setReading(d); setLoading(false); setError(null); },
      (err)  => { setError(`Lỗi: ${err.message}`); setLoading(false); }
    );
  }, []);

  useEffect(() => {
    setChartLoading(true);
    setChartData([]);
    const q = query(
      ref(db, '/soil-moisture/history'),
      orderByChild('timestamp'),
      startAt(`${selectedDate}T00:00:00`),
      endAt(`${selectedDate}T23:59:59`),
    );
    return onValue(q, (snap) => {
      setChartLoading(false);
      const d = snap.val();
      if (!d) return;
      setChartData(
        Object.values(d)
          .map((v: any) => ({ time: (v.timestamp as string).substring(11, 16), moisture: v.moisture as number }))
          .sort((a, b) => a.time.localeCompare(b.time))
      );
    });
  }, [selectedDate]);

  const isToday      = selectedDate >= getTodayString();
  const info         = reading ? getMoistureInfo(reading.moisture) : null;
  const labelStep    = Math.max(1, Math.ceil(chartData.length / 8));
  const chartLabels  = chartData.map((d, i) => i % labelStep === 0 ? d.time : '');
  const chartValues  = chartData.map(d => d.moisture);

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <Animated.View style={{ opacity: fadeAnim }}>

        {loading && (
          <View style={styles.center}>
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text style={styles.loadingText}>Đang kết nối Firebase...</Text>
          </View>
        )}
        {!loading && error && (
          <View style={styles.center}>
            <Text style={styles.emoji}>⚠️</Text>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}
        {!loading && !error && !reading && (
          <View style={styles.center}>
            <Text style={styles.emoji}>📡</Text>
            <Text style={styles.noDataTitle}>Chưa có dữ liệu</Text>
            <Text style={styles.noDataSub}>Kiểm tra kết nối ESP32</Text>
          </View>
        )}

        {/* ── Current reading ── */}
        {!loading && !error && reading && info && (
          <Animated.View style={{ opacity: flashAnim }}>
            <View style={styles.card}>
              <View style={[styles.gaugeRing, { borderColor: info.color }]}>
                <Text style={[styles.gaugeValue, { color: info.color }]}>{reading.moisture}</Text>
                <Text style={styles.gaugeUnit}>%</Text>
              </View>
              <View style={[styles.badge, { backgroundColor: info.color }]}>
                <Text style={styles.badgeText}>{info.label}</Text>
              </View>
              <View style={styles.barWrap}>
                <View style={styles.barTrack}>
                  <View style={[styles.barFill, { width: `${reading.moisture}%`, backgroundColor: info.color }]} />
                </View>
                <View style={styles.barLabels}>
                  <Text style={styles.barLabel}>0%</Text>
                  <Text style={styles.barLabel}>50%</Text>
                  <Text style={styles.barLabel}>100%</Text>
                </View>
              </View>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Chi tiết</Text>
              <View style={styles.row}><Text style={styles.rowLabel}>Độ ẩm</Text><Text style={[styles.rowValue, { color: info.color }]}>{reading.moisture}%</Text></View>
              <View style={styles.divider} />
              <View style={styles.row}><Text style={styles.rowLabel}>ADC thô</Text><Text style={styles.rowValue}>{reading.rawValue}</Text></View>
              <View style={styles.divider} />
              <View style={styles.row}><Text style={styles.rowLabel}>Cập nhật</Text><Text style={[styles.rowValue, styles.tsText]}>{formatTimestamp(reading.timestamp)}</Text></View>
            </View>

            <View style={styles.liveRow}>
              <View style={[styles.liveDot, { backgroundColor: '#22c55e' }]} />
              <Text style={styles.liveText}>Đang nhận dữ liệu trực tiếp từ Firebase</Text>
            </View>
          </Animated.View>
        )}

        {/* ── Chart ── */}
        {!loading && (
          <View style={[styles.card, { marginTop: 14 }]}>
            <Text style={styles.cardTitle}>Biểu đồ theo ngày</Text>

            <View style={styles.dateNav}>
              <TouchableOpacity style={styles.dateBtn} onPress={() => setSelectedDate(d => addDays(d, -1))}>
                <Text style={styles.dateBtnText}>‹</Text>
              </TouchableOpacity>
              <Text style={styles.dateText}>{formatDisplayDate(selectedDate)}</Text>
              <TouchableOpacity style={[styles.dateBtn, isToday && styles.dateBtnDisabled]} onPress={() => setSelectedDate(d => addDays(d, 1))} disabled={isToday}>
                <Text style={[styles.dateBtnText, isToday && styles.dateBtnTextDisabled]}>›</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.chartSubtitle}>
              {chartLoading ? 'Đang tải...' : `${chartData.length} điểm dữ liệu`}
            </Text>

            {chartLoading ? (
              <View style={styles.chartEmpty}><ActivityIndicator size="small" color="#3b82f6" /></View>
            ) : chartData.length >= 2 ? (
              <>
                <LineChart
                  data={{ labels: chartLabels, datasets: [{ data: chartValues }] }}
                  width={CHART_W} height={200}
                  chartConfig={{
                    backgroundColor: '#fff', backgroundGradientFrom: '#fff', backgroundGradientTo: '#f8fafc',
                    decimalPlaces: 0,
                    color: (o = 1) => `rgba(59,130,246,${o})`,
                    labelColor: () => '#94a3b8',
                    fillShadowGradient: '#3b82f6', fillShadowGradientOpacity: 0.15,
                    propsForDots: { r: chartData.length <= 72 ? '2.5' : '0', strokeWidth: '0', fill: '#3b82f6' },
                    propsForBackgroundLines: { strokeDasharray: '4 4', stroke: '#f1f5f9', strokeWidth: '1' },
                  }}
                  bezier withShadow withInnerLines withOuterLines={false}
                  style={styles.chartStyle} yAxisSuffix="%" fromZero
                />
                <View style={styles.legendRow}>
                  {[['#ef4444','Khô < 30%'],['#eab308','Vừa đủ 30–60%'],['#22c55e','Ẩm > 60%']].map(([c,l]) => (
                    <View key={l} style={styles.legendItem}>
                      <View style={[styles.legendDot, { backgroundColor: c }]} />
                      <Text style={styles.legendText}>{l}</Text>
                    </View>
                  ))}
                </View>
              </>
            ) : (
              <View style={styles.chartEmpty}>
                <Text style={styles.emoji}>📊</Text>
                <Text style={styles.noDataTitle}>Không có dữ liệu</Text>
                <Text style={styles.noDataSub}>Ngày {selectedDate} chưa có lần đo nào</Text>
              </View>
            )}
          </View>
        )}
      </Animated.View>
    </ScrollView>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab] = useState<'firebase' | 'bluetooth'>('firebase');

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#1e3a5f" />

      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Theo Dõi Độ Ẩm Đất</Text>
        <Text style={styles.headerSub}>Soil Moisture Monitor</Text>
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'firebase' && styles.tabActive]}
          onPress={() => setActiveTab('firebase')}
        >
          <Text style={[styles.tabText, activeTab === 'firebase' && styles.tabTextActive]}>
            📡 Firebase
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'bluetooth' && styles.tabActive]}
          onPress={() => setActiveTab('bluetooth')}
        >
          <Text style={[styles.tabText, activeTab === 'bluetooth' && styles.tabTextActive]}>
            🔵 Bluetooth
          </Text>
        </TouchableOpacity>
      </View>

      {/* Content */}
      {activeTab === 'firebase'
        ? <FirebaseScreen />
        : <BluetoothScreen />
      }
    </SafeAreaView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f1f5f9' },

  header: { backgroundColor: '#1e3a5f', paddingVertical: 16, paddingHorizontal: 20, alignItems: 'center' },
  headerTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff' },
  headerSub:   { fontSize: 12, color: '#93c5fd', marginTop: 4 },

  tabBar: { flexDirection: 'row', backgroundColor: '#1e3a5f', paddingHorizontal: 16, paddingBottom: 4 },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10, marginHorizontal: 4 },
  tabActive:     { backgroundColor: 'rgba(255,255,255,0.15)' },
  tabText:       { color: '#93c5fd', fontSize: 14, fontWeight: '500' },
  tabTextActive: { color: '#fff',    fontSize: 14, fontWeight: '700' },

  scroll: { padding: 16, flexGrow: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  loadingText: { marginTop: 14, fontSize: 15, color: '#64748b' },
  emoji:       { fontSize: 48, marginBottom: 10 },
  errorText:   { fontSize: 15, color: '#ef4444', textAlign: 'center' },
  noDataTitle: { fontSize: 18, fontWeight: '600', color: '#64748b' },
  noDataSub:   { fontSize: 13, color: '#94a3b8', marginTop: 6 },

  card: {
    backgroundColor: '#fff', borderRadius: 16, padding: 20, marginBottom: 14, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.07, shadowRadius: 6, elevation: 3,
  },
  cardTitle: { fontSize: 12, fontWeight: '600', color: '#94a3b8', alignSelf: 'flex-start', marginBottom: 14, letterSpacing: 0.8, textTransform: 'uppercase' },

  gaugeRing: { width: 180, height: 180, borderRadius: 90, borderWidth: 8, justifyContent: 'center', alignItems: 'center', marginVertical: 16 },
  gaugeValue: { fontSize: 60, fontWeight: 'bold', lineHeight: 68 },
  gaugeUnit:  { fontSize: 22, color: '#94a3b8' },

  badge:     { paddingHorizontal: 22, paddingVertical: 7, borderRadius: 20, marginBottom: 20 },
  badgeText: { color: '#fff', fontSize: 15, fontWeight: '600' },

  barWrap:   { width: '100%' },
  barTrack:  { height: 12, backgroundColor: '#e2e8f0', borderRadius: 6, overflow: 'hidden' },
  barFill:   { height: '100%', borderRadius: 6 },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  barLabel:  { fontSize: 11, color: '#94a3b8' },

  row:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11, width: '100%' },
  rowLabel: { fontSize: 14, color: '#64748b' },
  rowValue: { fontSize: 14, fontWeight: '600', color: '#1e293b' },
  tsText:   { fontSize: 12, textAlign: 'right', flex: 1, marginLeft: 12 },
  divider:  { height: 1, backgroundColor: '#f1f5f9', width: '100%' },

  liveRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  liveDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  liveText:{ fontSize: 12, color: '#22c55e' },

  dateNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 6 },
  dateBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#f1f5f9', justifyContent: 'center', alignItems: 'center' },
  dateBtnDisabled: { backgroundColor: '#f8fafc' },
  dateBtnText:     { fontSize: 24, color: '#3b82f6', fontWeight: '600', lineHeight: 28 },
  dateBtnTextDisabled: { color: '#cbd5e1' },
  dateText: { fontSize: 14, fontWeight: '600', color: '#334155', flex: 1, textAlign: 'center' },

  chartSubtitle: { fontSize: 12, color: '#94a3b8', alignSelf: 'flex-start', marginBottom: 12 },
  chartStyle:    { borderRadius: 12, marginLeft: -10 },
  chartEmpty:    { height: 160, alignItems: 'center', justifyContent: 'center', width: '100%' },

  legendRow:  { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 12, marginTop: 10, width: '100%' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot:  { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11, color: '#64748b' },
});
