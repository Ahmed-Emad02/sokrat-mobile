/**
 * Lightweight i18n + RTL support for Sokrat VOICE.
 *
 * The app is English-first; Arabic is opt-in from Settings. Changing the
 * language updates copy immediately and persists the choice. Native layout
 * direction (RTL) is applied on the next app start because React Native's
 * I18nManager requires a restart.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { I18nManager } from 'react-native';
import { useEffect, useState } from 'react';

export type Language = 'en' | 'ar';

const STORAGE_KEY = '@sokrat/language';
let currentLanguage: Language = 'en';
const listeners = new Set<() => void>();

export const translations: Record<string, string> = {
  // Navigation / status
  Contacts: 'جهات الاتصال',
  Favourites: 'المفضلة',
  Chat: 'الدردشة',
  'New Conversation': 'محادثة جديدة',
  Connected: 'متصل',
  'Connecting...': 'جارٍ الاتصال...',
  Offline: 'غير متصل',
  Phone: 'الهاتف',
  All: 'الكل',
  Missed: 'الفائتة',
  'No recent calls': 'لا توجد مكالمات حديثة',
  'No missed calls': 'لا توجد مكالمات فائتة',
  VoIP: 'VoIP',
  Back: 'رجوع',
  Profile: 'الملف الشخصي',
  'Call History': 'سجل المكالمات',
  Today: 'اليوم',
  Incoming: 'واردة',
  Outgoing: 'صادرة',
  Unknown: 'غير معروف',
  calls: 'مكالمات',
  missed: 'فائتة',
  'No calls with this number': 'لا توجد مكالمات لهذا الرقم',
  'Delete call?': 'حذف المكالمة؟',
  'Remove this call from the history?': 'إزالة هذه المكالمة من السجل؟',
  'Tap to call, hold to delete': 'اضغط للاتصال، واضغط مطولًا للحذف',
  WhatsApp: 'واتساب',
  'Could not open WhatsApp.': 'تعذر فتح واتساب.',
  'WhatsApp country code': 'رمز دولة واتساب',
  'Ask for country code when needed': 'اطلب رمز الدولة عند الحاجة',
  'Prompt once for local numbers': 'اطلب الرمز مرة واحدة للأرقام المحلية',
  'Enter the country code for': 'أدخل رمز الدولة للرقم',
  'e.g. 20': 'مثال: 20',
  'Enter a valid country code.': 'أدخل رمز دولة صالحًا.',
  'This number cannot be used with WhatsApp.': 'لا يمكن استخدام هذا الرقم مع واتساب.',
  'Set a WhatsApp country code in Settings to message local numbers.':
    'عيّن رمز دولة واتساب من الإعدادات لمراسلة الأرقام المحلية.',
  OK: 'موافق',
  Continue: 'متابعة',
  Bookmark: 'إضافة إلى المفضلة',
  Bookmarked: 'في المفضلة',
  'Remove bookmark': 'إزالة من المفضلة',
  'Copy phone number': 'نسخ رقم الهاتف',
  Copied: 'تم النسخ',
  Edit: 'تعديل',
  'Edit Contact': 'تعديل جهة الاتصال',
  'Add New Contact': 'إضافة جهة اتصال جديدة',
  'Delete contact?': 'حذف جهة الاتصال؟',
  'This contact will be removed. Your call history stays.':
    'ستُحذف جهة الاتصال. سيبقى سجل المكالمات.',
  'No contacts found': 'لا توجد جهات اتصال مطابقة',
  'Add to contacts': 'إضافة إلى جهات الاتصال',
  'Redial last number': 'إعادة الاتصال بالرقم الأخير',
  'Hide dialpad': 'إخفاء لوحة الأرقام',
  'Show dialpad': 'إظهار لوحة الأرقام',
  Settings: 'الإعدادات',
  Language: 'اللغة',
  English: 'English',
  Arabic: 'العربية',
  'Restart the app to apply the new layout direction.': 'أعد تشغيل التطبيق لتطبيق اتجاه الواجهة الجديد.',

  // Menu
  'Settings & PBX Host': 'الإعدادات ومضيف PBX',
  'Clear History': 'مسح السجل',
  'Add Contact': 'إضافة جهة اتصال',
  'Sync Phone Contacts': 'مزامنة جهات اتصال الهاتف',
  'Sign Out': 'تسجيل الخروج',

  // Contacts
  'Search contacts…': 'ابحث في جهات الاتصال…',
  Import: 'استيراد',
  'Syncing…': 'جارٍ المزامنة…',
  'No favourites yet. Bookmark contacts to see them here.':
    'لا توجد مفضلة بعد. أضف إشارة مرجعية لجهة اتصال لعرضها هنا.',

  // Settings
  'PBX Server & Credentials': 'خادم PBX وبيانات الاعتماد',
  'SIP EXTENSION': 'تحويلة SIP',
  'SIP PASSWORD': 'كلمة مرور SIP',
  'PBX SERVER HOST / IP': 'مضيف / عنوان IP لخادم PBX',
  'TLS / WSS Protocol': 'بروتوكول TLS / WSS',
  'Port 8088 (Plain WS on LAN)': 'المنفذ 8088 (WS عادي على الشبكة المحلية)',
  'Do Not Disturb (DND)': 'عدم الإزعاج (DND)',
  'Auto-reject incoming calls': 'رفض المكالمات الواردة تلقائيًا',
  'Auto-Answer': 'الرد التلقائي',
  'Auto-accept incoming calls': 'قبول المكالمات الواردة تلقائيًا',
  'Preferred Audio Codec': 'الترميز الصوتي المفضل',
  'Speaker Output Volume': 'مستوى صوت السماعة',
  'Microphone Sensitivity': 'حساسية الميكروفون',
  Handset: 'الهاتف',
  Speaker: 'السماعة',
  Bluetooth: 'بلوتوث',
  'Speed Dial (Keys 1 – 9)': 'الاتصال السريع (المفاتيح 1 – 9)',
  'Save & Connect': 'حفظ واتصال',
  Done: 'تم',
  Cancel: 'إلغاء',

  // In-call
  Mute: 'كتم',
  Unmute: 'إلغاء الكتم',
  Keypad: 'لوحة الأرقام',
  Earpiece: 'سماعة الأذن',
  Hold: 'تعليق',
  Resume: 'استئناف',
  Transfer: 'تحويل',
  Volume: 'الصوت',
  'End Call': 'إنهاء المكالمة',
  'Audio & Volume Controls': 'التحكم في الصوت',
  'Audio Output & Input': 'إخراج وإدخال الصوت',
  'Select active device for microphone and speaker:':
    'اختر الجهاز النشط للميكروفون والسماعة:',
  'Phone Earpiece': 'سماعة الهاتف',
  Loudspeaker: 'مكبر الصوت',
  'Handset speaker & microphone': 'سماعة الهاتف والميكروفون',
  'Hands-free speakerphone': 'مكبر صوت حر اليدين',
  'Wireless connected audio': 'صوت لاسلكي متصل',
  'Wired Headset': 'سماعة سلكية',
  '3.5 mm or USB audio': 'صوت 3.5 مم أو USB',
  'Transfer Call': 'تحويل المكالمة',
  Blind: 'تحويل مباشر',
  Warm: 'تحويل مع استشارة',
  Swap: 'تبديل',
  Complete: 'إكمال',
  'Transferring…': 'جارٍ التحويل…',
  'Swapping…': 'جارٍ التبديل…',
  'Cancelling…': 'جارٍ الإلغاء…',
  'Call Details': 'تفاصيل المكالمة',
  Duration: 'المدة',
  Delete: 'حذف',
  Call: 'اتصال',
  Close: 'إغلاق',


  'Connecting…': 'جارٍ الاتصال…',
  'Just now': 'الآن',
  'min ago': 'دقيقة مضت',
  'hr ago': 'ساعة مضت',
  Yesterday: 'أمس',
  'Missed call': 'مكالمة فائتة',
  'PBX HOST / IP ADDRESS': 'مضيف / عنوان IP لخادم PBX',
  'Server:': 'الخادم:',
  'CONNECTED • HD AUDIO': 'متصل • صوت عالي الدقة',
  'RINGING…': 'رنين…',
  'DIALING…': 'جارٍ الاتصال…',
  Consult: 'استشارة',
  'Port 8089 (WSS)': 'المنفذ 8089 (WSS)',

  // Ringing / login
  'Incoming Call': 'مكالمة واردة',
  'Ringing softphone…': 'رنين الهاتف…',
  'Connecting audio…': 'جارٍ توصيل الصوت…',
  Decline: 'رفض',
  Answer: 'رد',
  'Configure Server': 'إعداد الخادم',
  'Hide Server Settings': 'إخفاء إعدادات الخادم',
  'SIGN IN': 'تسجيل الدخول',
  'CONNECTING…': 'جارٍ الاتصال…',
  'Not Connected': 'غير متصل',
  'Call Failed': 'فشلت المكالمة',
  'Registration Failed': 'فشل التسجيل',
  'Call Ended': 'انتهت المكالمة',
  'Transfer Failed': 'فشل التحويل',
  'Connection failed. Please check host and extension secret.':
    'فشل الاتصال. تحقق من المضيف وسر التحويلة.',

  // Device approval (gateway enrollment)
  'Checking server…': 'جارٍ التحقق من الخادم…',
  'Waiting for administrator approval…': 'بانتظار موافقة المسؤول…',
  'Waiting for the gateway…': 'بانتظار البوابة…',
  'Device approved': 'تمت الموافقة على الجهاز',
  'Enrollment expired. Re-requesting approval…': 'انتهت صلاحية الطلب. جارٍ إعادة طلب الموافقة…',
  'The PBX is disabled for this account. Waiting for the administrator…':
    'المقسم معطّل لهذا الحساب. بانتظار المسؤول…',
  'This device was not approved by the administrator.': 'لم يوافق المسؤول على هذا الجهاز.',
  'This device has been revoked. Contact your administrator.':
    'تم إلغاء هذا الجهاز. تواصل مع المسؤول.',
  'The gateway rejected this device credential.': 'رفضت البوابة بيانات اعتماد هذا الجهاز.',
  'Gateway detected but unreachable. Direct PBX fallback is disabled.':
    'تم اكتشاف البوابة لكنها غير متاحة. الاتصال المباشر بالمقسم معطّل.',
  'Cannot reach the gateway. Check the server host and try again.':
    'تعذر الوصول إلى البوابة. تحقق من عنوان الخادم وحاول مجددًا.',
  'The enrollment request expired. Please sign in again.':
    'انتهت صلاحية طلب التسجيل. سجّل الدخول مجددًا.',
  'Device enrollment was cancelled.': 'تم إلغاء تسجيل الجهاز.',
  'Device enrollment failed.': 'فشل تسجيل الجهاز.',
};

export function t(source: string): string {
  if (currentLanguage !== 'ar') return source;
  return translations[source] ?? source;
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function isArabic(): boolean {
  return currentLanguage === 'ar';
}

function notify() {
  listeners.forEach((listener) => listener());
}

export async function initI18n(): Promise<void> {
  I18nManager.allowRTL(true);
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved === 'ar' || saved === 'en') {
      currentLanguage = saved;
    }
  } catch {}
  I18nManager.forceRTL(currentLanguage === 'ar');
  notify();
}

export async function setLanguage(language: Language): Promise<void> {
  currentLanguage = language;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, language);
  } catch {}
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(language === 'ar');
  notify();
}

export function useI18n(): { lang: Language; isRTL: boolean; t: (s: string) => string } {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    lang: currentLanguage,
    isRTL: currentLanguage === 'ar',
    t,
  };
}
