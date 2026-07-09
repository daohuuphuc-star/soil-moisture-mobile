import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey:            "AIzaSyBUkEX1WT09Wg-PbVTgk7KONe0YMPQb9y4",
  authDomain:        "esp32-dodoam.firebaseapp.com",
  databaseURL:       "https://esp32-dodoam-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "esp32-dodoam",
  storageBucket:     "esp32-dodoam.appspot.com",
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID ?? "",
  appId:             process.env.EXPO_PUBLIC_FIREBASE_APP_ID ?? "",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
