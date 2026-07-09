import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

const firebaseConfig = {
  apiKey:            "AIzaSyBUkEX1WT09Wg-PbVTgk7KONe0YMPQb9y4",
  authDomain:        "esp32-dodoam.firebaseapp.com",
  databaseURL:       "https://esp32-dodoam-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "esp32-dodoam",
  storageBucket:     "esp32-dodoam.firebasestorage.app",
  messagingSenderId: "471349585287",
  appId:             "1:471349585287:web:f8660aed5fce12bb3f9f22",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
