import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ActivityIndicator,
  StyleSheet, ScrollView, Platform, Alert, Animated,
} from 'react-native';
import { BleManager, Device, BleError } from 'react-native-ble-plx';
import { ref, set, push } from 'firebase/database';
import { db } from './firebase';
import { PermissionsAndroid } from 'react-native';

// ── UUIDs — phải khớp với ESP32 firmware ─────────────
const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_CHAR_UUID    = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const DEVICE_NAME      = 'ESP32-SoilSensor';
const SCAN_TIMEOUT_MS  = 15000;
const RECONNECT_DELAY_MS = 3000;

// Singleton BleManager — tạo 1 lần duy nhất
const bleManager = new BleManager();

// ── Types ─────────────────────────────────────────────
interface BleReading {
  moisture:  number;
  rawValue:  number;
  timestamp: string;
}

type Status = 'idle' | 'requesting' | 'scanning' | 'connecting' | 'connected' | 'reconnecting' | 'error';

// ── Helpers ───────────────────────────────────────────
function getMoistureInfo(m: number) {
  if (m < 20) return { color: '#ef4444', label: 'Rất khô' };
  if (m < 40) return { color: '#f97316', label: 'Khô' };
  if (m < 60) return { color: '#eab308', label: 'Vừa đủ' };
  if (m < 80) return { color: '#84cc16', label: 'Ẩm' };
  return { color: '#22c55e', label: 'Rất ẩm' };
}

function decodeBase64(b64: string): string {
  return atob(b64);
}

function getPhoneTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  try {
    if (Platform.Version >= 31) {
      const results = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
      return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
    } else {
      const result = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
      );
      return result === PermissionsAndroid.RESULTS.GRANTED;
    }
  } catch {
    return false;
  }
}

// ── Component ─────────────────────────────────────────
export default function BluetoothScreen() {
  const [status,     setStatus]     = useState<Status>('idle');
  const [reading,    setReading]    = useState<BleReading | null>(null);
  const [autoSync,   setAutoSync]   = useState(true);
  const [syncCount,  setSyncCount]  = useState(0);
  const [errorMsg,   setErrorMsg]   = useState('');
  const [connDevice, setConnDevice] = useState<Device | null>(null);

  const flashAnim          = useRef(new Animated.Value(1)).current;
  const manualDisconnectRef = useRef(false);   // true khi user bấm Ngắt kết nối
  const reconnectTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSyncRef         = useRef(autoSync);

  useEffect(() => { autoSyncRef.current = autoSync; }, [autoSync]);

  const flash = () => {
    Animated.sequence([
      Animated.timing(flashAnim, { toValue: 0.3, duration: 120, useNativeDriver: true }),
      Animated.timing(flashAnim, { toValue: 1,   duration: 250, useNativeDriver: true }),
    ]).start();
  };

  // Cleanup khi unmount
  useEffect(() => {
    return () => {
      bleManager.stopDeviceScan();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      connDevice?.cancelConnection().catch(() => {});
    };
  }, [connDevice]);

  // ── Xử lý dữ liệu nhận từ BLE ────────────────────
  const handleNewValue = useCallback((base64Value: string) => {
    try {
      const json  = decodeBase64(base64Value);
      const data  = JSON.parse(json) as BleReading;
      setReading(data);
      flash();
      if (autoSyncRef.current) pushToFirebase(data);
    } catch (e) {
      console.warn('BLE parse error:', e);
    }
  }, []);

  // ── Đẩy dữ liệu lên Firebase ─────────────────────
  const pushToFirebase = async (data: BleReading) => {
    const ts = getPhoneTimestamp();
    try {
      await set(ref(db, '/soil-moisture/latest'), {
        ...data, timestamp: ts, unit: 'percent',
      });
      await push(ref(db, '/soil-moisture/history'), {
        moisture: data.moisture, timestamp: ts,
      });
      setSyncCount(c => c + 1);
    } catch (e: any) {
      Alert.alert('Firebase Error', e.message);
    }
  };

  // ── Kết nối thiết bị ──────────────────────────────
  const connectToDevice = useCallback(async (device: Device) => {
    setStatus('connecting');
    try {
      const connected = await device.connect({ timeout: 10000 });
      await connected.discoverAllServicesAndCharacteristics();
      setConnDevice(connected);
      setStatus('connected');

      // Đọc giá trị ngay lập tức
      const char = await connected.readCharacteristicForService(BLE_SERVICE_UUID, BLE_CHAR_UUID);
      if (char.value) handleNewValue(char.value);

      // Đăng ký nhận notifications
      connected.monitorCharacteristicForService(
        BLE_SERVICE_UUID,
        BLE_CHAR_UUID,
        (err, c) => {
          if (c?.value) handleNewValue(c.value);
        }
      );

      // Xử lý mất kết nối — tự động kết nối lại nếu không phải do user
      connected.onDisconnected(() => {
        setConnDevice(null);
        if (manualDisconnectRef.current) {
          setStatus('idle');
          setReading(null);
          return;
        }
        setStatus('reconnecting');
        reconnectTimerRef.current = setTimeout(() => {
          doScan();
        }, RECONNECT_DELAY_MS);
      });

    } catch (e: any) {
      if (!manualDisconnectRef.current) {
        setStatus('reconnecting');
        reconnectTimerRef.current = setTimeout(() => doScan(), RECONNECT_DELAY_MS);
      } else {
        setStatus('idle');
      }
    }
  }, [handleNewValue]);

  // ── Quét BLE (không cần xin quyền lại) ───────────
  const doScan = useCallback(() => {
    bleManager.stopDeviceScan();
    setStatus('scanning');
    let found = false;

    bleManager.startDeviceScan(
      null,
      { allowDuplicates: false },
      async (error: BleError | null, device: Device | null) => {
        if (error) {
          if (!manualDisconnectRef.current) {
            setStatus('reconnecting');
            reconnectTimerRef.current = setTimeout(() => doScan(), RECONNECT_DELAY_MS);
          }
          return;
        }
        if (device && (device.name === DEVICE_NAME || device.localName === DEVICE_NAME)) {
          found = true;
          bleManager.stopDeviceScan();
          await connectToDevice(device);
        }
      }
    );

    setTimeout(() => {
      bleManager.stopDeviceScan();
      if (!found && !manualDisconnectRef.current) {
        setStatus(cur => {
          if (cur === 'scanning') {
            // ESP32 chưa tìm thấy, thử lại sau
            reconnectTimerRef.current = setTimeout(() => doScan(), RECONNECT_DELAY_MS);
            return 'reconnecting';
          }
          return cur;
        });
      }
    }, SCAN_TIMEOUT_MS);
  }, [connectToDevice]);

  // ── Bắt đầu quét (lần đầu — xin quyền trước) ────
  const startScan = useCallback(async () => {
    manualDisconnectRef.current = false;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setStatus('requesting');
    setErrorMsg('');

    const granted = await requestAndroidPermissions();
    if (!granted) {
      setStatus('error');
      setErrorMsg('Cần cấp quyền Bluetooth và Location để quét thiết bị.');
      return;
    }
    doScan();
  }, [doScan]);

  // ── Ngắt kết nối (thủ công) ───────────────────────
  const disconnect = async () => {
    manualDisconnectRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    bleManager.stopDeviceScan();
    await connDevice?.cancelConnection().catch(() => {});
    setConnDevice(null);
    setStatus('idle');
    setReading(null);
    setSyncCount(0);
  };

  const info           = reading ? getMoistureInfo(reading.moisture) : null;
  const isConnected    = status === 'connected';
  const isReconnecting = status === 'reconnecting';
  const isBusy         = ['scanning', 'connecting', 'requesting'].includes(status);
  const showData       = (isConnected || isReconnecting) && reading && info;

  return (
    <ScrollView contentContainerStyle={styles.scroll}>

      {/* ── Trạng thái kết nối ── */}
      <View style={styles.statusCard}>
        <View style={[styles.statusDot, {
          backgroundColor:
            isConnected    ? '#22c55e' :
            isReconnecting ? '#f59e0b' :
            status === 'error' ? '#ef4444' : '#94a3b8',
        }]} />
        <Text style={styles.statusText}>
          {status === 'idle'         && 'Chưa kết nối'}
          {status === 'requesting'   && 'Đang yêu cầu quyền...'}
          {status === 'scanning'     && `Đang tìm "${DEVICE_NAME}"...`}
          {status === 'connecting'   && 'Đang kết nối...'}
          {isConnected               && `Đã kết nối: ${DEVICE_NAME}`}
          {isReconnecting            && `Mất kết nối — đang kết nối lại...`}
          {status === 'error'        && errorMsg}
        </Text>
        {(isBusy || isReconnecting) && <ActivityIndicator size="small" color="#f59e0b" />}
      </View>

      {/* ── Nút điều khiển ── */}
      {!isConnected && !isReconnecting ? (
        <TouchableOpacity
          style={[styles.btn, styles.btnBlue, isBusy && styles.btnDisabled]}
          onPress={startScan}
          disabled={isBusy}
        >
          {isBusy
            ? <ActivityIndicator color="#fff" />
            : <Text style={styles.btnText}>🔵  Bắt đầu quét</Text>
          }
        </TouchableOpacity>
      ) : (
        <TouchableOpacity style={[styles.btn, styles.btnRed]} onPress={disconnect}>
          <Text style={styles.btnText}>✕  Ngắt kết nối</Text>
        </TouchableOpacity>
      )}

      {/* ── Dữ liệu độ ẩm (hiển thị cả khi đang reconnect) ── */}
      {showData && (
        <Animated.View style={{ opacity: isReconnecting ? 0.5 : flashAnim }}>

          <View style={styles.card}>
            {isReconnecting && (
              <View style={styles.staleBadge}>
                <Text style={styles.staleText}>Dữ liệu cuối — đang kết nối lại</Text>
              </View>
            )}

            {/* Gauge */}
            <View style={[styles.gauge, { borderColor: info!.color }]}>
              <Text style={[styles.gaugeValue, { color: info!.color }]}>{reading!.moisture}</Text>
              <Text style={styles.gaugeUnit}>%</Text>
            </View>

            <View style={[styles.badge, { backgroundColor: info!.color }]}>
              <Text style={styles.badgeText}>{info!.label}</Text>
            </View>

            {/* Bar */}
            <View style={styles.barWrap}>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, {
                  width: `${reading!.moisture}%`,
                  backgroundColor: info!.color,
                }]} />
              </View>
            </View>

            {/* Details */}
            <View style={styles.detailsWrap}>
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Độ ẩm</Text>
                <Text style={[styles.rowValue, { color: info!.color }]}>{reading!.moisture}%</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>ADC thô</Text>
                <Text style={styles.rowValue}>{reading!.rawValue}</Text>
              </View>
              <View style={styles.divider} />
              <View style={styles.row}>
                <Text style={styles.rowLabel}>Timestamp</Text>
                <Text style={[styles.rowValue, { fontSize: 11 }]}>{reading!.timestamp}</Text>
              </View>
            </View>
          </View>

          {/* ── Đồng bộ Firebase ── */}
          {isConnected && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Đồng bộ Firebase</Text>

              <View style={styles.row}>
                <Text style={styles.rowLabel}>Tự động đẩy lên Firebase</Text>
                <TouchableOpacity
                  style={[styles.toggle, autoSync && styles.toggleOn]}
                  onPress={() => setAutoSync(v => !v)}
                >
                  <Text style={styles.toggleText}>{autoSync ? 'BẬT' : 'TẮT'}</Text>
                </TouchableOpacity>
              </View>

              <View style={styles.divider} />

              <View style={styles.row}>
                <Text style={styles.rowLabel}>Số lần đã đồng bộ</Text>
                <Text style={[styles.rowValue, { color: '#22c55e' }]}>{syncCount}</Text>
              </View>

              {!autoSync && reading && (
                <>
                  <View style={styles.divider} />
                  <TouchableOpacity
                    style={[styles.btn, styles.btnGreen, { marginTop: 10 }]}
                    onPress={() => pushToFirebase(reading)}
                  >
                    <Text style={styles.btnText}>☁  Đẩy lên Firebase ngay</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          )}
        </Animated.View>
      )}

      {/* ── Hướng dẫn ── */}
      {status === 'idle' && (
        <View style={styles.guideCard}>
          <Text style={styles.guideTitle}>Hướng dẫn kết nối BLE</Text>
          {[
            '1. Đảm bảo ESP32 đang bật nguồn',
            '2. Nhấn "Bắt đầu quét" ở trên',
            '3. Chấp nhận quyền Bluetooth khi được hỏi',
            '4. App sẽ tự động kết nối với ESP32-SoilSensor',
            '5. Nếu bị rớt kết nối, app tự động kết nối lại',
          ].map((t, i) => (
            <Text key={i} style={styles.guideItem}>{t}</Text>
          ))}
          <Text style={styles.guideNote}>
            💡 Chế độ BLE hữu ích khi ESP32 không có WiFi — điện thoại sẽ đọc dữ liệu qua BLE và đẩy lên Firebase thay cho ESP32.
          </Text>
        </View>
      )}

    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────
const styles = StyleSheet.create({
  scroll: { padding: 16, paddingBottom: 32 },

  statusCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    marginBottom: 14, gap: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06, shadowRadius: 4, elevation: 2,
  },
  statusDot:  { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 14, color: '#334155', flex: 1 },

  btn: {
    borderRadius: 14, paddingVertical: 14,
    alignItems: 'center', marginBottom: 14,
  },
  btnBlue:     { backgroundColor: '#3b82f6' },
  btnRed:      { backgroundColor: '#ef4444' },
  btnGreen:    { backgroundColor: '#22c55e' },
  btnDisabled: { backgroundColor: '#94a3b8' },
  btnText:     { color: '#fff', fontWeight: '700', fontSize: 15 },

  card: {
    backgroundColor: '#fff', borderRadius: 16, padding: 20,
    marginBottom: 14, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07, shadowRadius: 6, elevation: 3,
  },
  cardTitle: {
    fontSize: 12, fontWeight: '600', color: '#94a3b8',
    alignSelf: 'flex-start', marginBottom: 14,
    letterSpacing: 0.8, textTransform: 'uppercase',
  },

  staleBadge: {
    backgroundColor: '#fef3c7', borderRadius: 8, paddingHorizontal: 12,
    paddingVertical: 4, marginBottom: 8,
  },
  staleText: { fontSize: 11, color: '#92400e' },

  gauge: {
    width: 160, height: 160, borderRadius: 80,
    borderWidth: 7, justifyContent: 'center', alignItems: 'center',
    marginVertical: 16,
  },
  gaugeValue: { fontSize: 52, fontWeight: 'bold', lineHeight: 60 },
  gaugeUnit:  { fontSize: 20, color: '#94a3b8' },

  badge: { paddingHorizontal: 20, paddingVertical: 6, borderRadius: 20, marginBottom: 16 },
  badgeText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  barWrap:  { width: '100%', marginBottom: 16 },
  barTrack: { height: 10, backgroundColor: '#e2e8f0', borderRadius: 5, overflow: 'hidden' },
  barFill:  { height: '100%', borderRadius: 5 },

  detailsWrap: { width: '100%' },
  row:      { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10, width: '100%' },
  rowLabel: { fontSize: 14, color: '#64748b' },
  rowValue: { fontSize: 14, fontWeight: '600', color: '#1e293b' },
  divider:  { height: 1, backgroundColor: '#f1f5f9', width: '100%' },

  waitText: { marginTop: 14, color: '#64748b', fontSize: 14 },

  toggle: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 20, backgroundColor: '#e2e8f0',
  },
  toggleOn:   { backgroundColor: '#22c55e' },
  toggleText: { fontSize: 12, fontWeight: '700', color: '#fff' },

  guideCard: {
    backgroundColor: '#eff6ff', borderRadius: 16, padding: 18,
    borderWidth: 1, borderColor: '#bfdbfe',
  },
  guideTitle: { fontSize: 14, fontWeight: '700', color: '#1e40af', marginBottom: 12 },
  guideItem:  { fontSize: 13, color: '#334155', marginBottom: 6, lineHeight: 20 },
  guideNote:  { marginTop: 12, fontSize: 12, color: '#475569', lineHeight: 18 },
});
