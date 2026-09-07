/* Browser-locale UI translations. Missing messages always fall back to English. */

(() => {
  const english = {
    title: 'censor — blur & mosaic editor',
    tagline: 'blur & pixelate parts of a photo.',
    privacy: 'everything stays on your device.',
    openImage: 'open an image',
    loadClipboard: 'load from clipboard',
    hint: 'draw boxes or scribble freely · adjust strength per object · drag to reposition',
    mosaic: 'mosaic', blur: 'blur', brush: 'brush',
    deleteObject: 'delete object', done: 'done',
    boxTool: 'box (M)', freehandTool: 'freehand (B)', moveTool: 'pan / move objects (V)',
    undo: 'undo', redo: 'redo', fitScreen: 'fit to screen', clearAll: 'clear all',
    newImage: 'new image', copyOutput: 'copy output image', saveImage: 'save image',
    dropOpen: 'drop image to open',
    openFailed: 'Could not open that image.',
    dropImageOnly: 'Drop an image file here.',
    replaceConfirm: 'Replace the current image? Your current edits and undo history will be lost.',
    clipboardEmpty: 'The clipboard does not contain an image.',
    clipboardUnavailable: 'Clipboard access is unavailable here. Try Cmd/Ctrl+V.',
    clipboardBlocked: 'Clipboard access was blocked. Try Cmd/Ctrl+V.',
    clearConfirm: 'Remove every censor object?',
    newImageConfirm: 'Open a new image? Your current edits and undo history will be lost.',
    copyUnsupported: 'Copying images is not supported in this browser.',
    copySuccess: 'Output image copied to clipboard.',
    copyFailed: 'Could not copy the image. Check clipboard permission and try again.',
    saveFailed: 'Could not save the image.',
  };

  const coreKeys = [
    'title', 'tagline', 'privacy', 'openImage', 'loadClipboard', 'hint',
    'mosaic', 'blur', 'brush', 'deleteObject', 'done', 'boxTool',
    'freehandTool', 'moveTool', 'undo', 'redo', 'fitScreen', 'clearAll',
    'newImage', 'copyOutput', 'saveImage', 'dropOpen',
  ];

  // Hand-written translations. Alert text not present in a locale uses English.
  const coreRows = {
    ar: ['censor — محرر التمويه والفسيفساء','موّه أجزاء من الصورة أو حوّلها إلى بكسلات.','كل شيء يبقى على جهازك.','فتح صورة','تحميل من الحافظة','ارسم مربعات أو خطوطًا بحرية · اضبط القوة لكل عنصر · اسحب لتغيير الموضع','فسيفساء','تمويه','فرشاة','حذف العنصر','تم','مربع (M)','رسم حر (B)','تحريك / نقل العناصر (V)','تراجع','إعادة','ملاءمة للشاشة','مسح الكل','صورة جديدة','نسخ الصورة الناتجة','حفظ الصورة','أفلت الصورة لفتحها'],
    bn: ['censor — ব্লার ও মোজাইক সম্পাদক','ছবির কিছু অংশ ব্লার বা পিক্সেল করুন।','সবকিছু আপনার ডিভাইসেই থাকে।','ছবি খুলুন','ক্লিপবোর্ড থেকে লোড করুন','বাক্স আঁকুন বা স্বাধীনভাবে আঁকুন · প্রতিটি বস্তুর শক্তি বদলান · সরিয়ে নিতে টানুন','মোজাইক','ব্লার','ব্রাশ','বস্তু মুছুন','সম্পন্ন','বাক্স (M)','মুক্তহস্ত (B)','প্যান / বস্তু সরান (V)','পূর্বাবস্থা','পুনরায়','স্ক্রিনে মানান','সব মুছুন','নতুন ছবি','আউটপুট ছবি কপি করুন','ছবি সংরক্ষণ করুন','খুলতে ছবি ছাড়ুন'],
    cs: ['censor — editor rozmazání a mozaiky','Rozmažte nebo rozpixelujte části fotografie.','Vše zůstává ve vašem zařízení.','otevřít obrázek','načíst ze schránky','kreslete rámečky nebo volně · upravte sílu každého objektu · přetažením přemístěte','mozaika','rozmazání','štětec','odstranit objekt','hotovo','rámeček (M)','volná kresba (B)','posun / přesun objektů (V)','zpět','znovu','přizpůsobit obrazovce','vymazat vše','nový obrázek','kopírovat výsledný obrázek','uložit obrázek','přetažením otevřete obrázek'],
    da: ['censor — slørings- og mosaikeditor','Slør eller pixelér dele af et foto.','Alt forbliver på din enhed.','åbn et billede','indlæs fra udklipsholder','tegn felter eller frit · juster styrken pr. objekt · træk for at flytte','mosaik','sløring','pensel','slet objekt','færdig','felt (M)','frihånd (B)','panorér / flyt objekter (V)','fortryd','annuller fortryd','tilpas til skærm','ryd alt','nyt billede','kopiér resultatbillede','gem billede','slip billede for at åbne'],
    de: ['censor — Weichzeichner- & Mosaikeditor','Bereiche eines Fotos weichzeichnen oder verpixeln.','Alles bleibt auf deinem Gerät.','Bild öffnen','aus Zwischenablage laden','Rechtecke oder frei zeichnen · Stärke je Objekt anpassen · zum Verschieben ziehen','Mosaik','Weichzeichnen','Pinsel','Objekt löschen','fertig','Rechteck (M)','Freihand (B)','Ansicht / Objekte verschieben (V)','rückgängig','wiederholen','an Bildschirm anpassen','alles löschen','neues Bild','Ausgabebild kopieren','Bild speichern','Bild zum Öffnen ablegen'],
    el: ['censor — επεξεργασία θόλωσης και μωσαϊκού','Θολώστε ή εικονοστοιχειοποιήστε μέρη μιας φωτογραφίας.','Όλα παραμένουν στη συσκευή σας.','άνοιγμα εικόνας','φόρτωση από πρόχειρο','σχεδιάστε πλαίσια ή ελεύθερα · ρυθμίστε την ένταση ανά αντικείμενο · σύρετε για μετακίνηση','μωσαϊκό','θόλωση','πινέλο','διαγραφή αντικειμένου','τέλος','πλαίσιο (M)','ελεύθερο σχέδιο (B)','μετατόπιση / μετακίνηση αντικειμένων (V)','αναίρεση','επανάληψη','προσαρμογή στην οθόνη','εκκαθάριση όλων','νέα εικόνα','αντιγραφή εικόνας εξόδου','αποθήκευση εικόνας','αφήστε την εικόνα για άνοιγμα'],
    es: ['censor — editor de desenfoque y mosaico','Desenfoca o pixela partes de una foto.','Todo permanece en tu dispositivo.','abrir una imagen','cargar del portapapeles','dibuja cuadros o a mano alzada · ajusta la intensidad de cada objeto · arrastra para mover','mosaico','desenfoque','pincel','eliminar objeto','listo','cuadro (M)','mano alzada (B)','desplazar / mover objetos (V)','deshacer','rehacer','ajustar a pantalla','borrar todo','nueva imagen','copiar imagen resultante','guardar imagen','suelta la imagen para abrirla'],
    fa: ['censor — ویرایشگر محو و موزاییک','بخش‌هایی از عکس را محو یا پیکسلی کنید.','همه‌چیز روی دستگاه شما می‌ماند.','باز کردن تصویر','بارگیری از کلیپ‌بورد','کادر بکشید یا آزادانه طراحی کنید · شدت هر شیء را تنظیم کنید · برای جابه‌جایی بکشید','موزاییک','محو','قلم‌مو','حذف شیء','تمام','کادر (M)','طراحی آزاد (B)','حرکت نما / اشیاء (V)','واگرد','از نو','جا دادن در صفحه','پاک کردن همه','تصویر جدید','کپی تصویر خروجی','ذخیره تصویر','برای باز کردن، تصویر را رها کنید'],
    fi: ['censor — sumennus- ja mosaiikkieditori','Sumenna tai pikselöi kuvan osia.','Kaikki pysyy laitteellasi.','avaa kuva','lataa leikepöydältä','piirrä laatikoita tai vapaasti · säädä voimakkuutta kohteittain · siirrä vetämällä','mosaiikki','sumennus','sivellin','poista kohde','valmis','laatikko (M)','vapaapiirto (B)','panoroi / siirrä kohteita (V)','kumoa','tee uudelleen','sovita näyttöön','tyhjennä kaikki','uusi kuva','kopioi tuloskuva','tallenna kuva','avaa pudottamalla kuva'],
    fr: ['censor — éditeur de flou et mosaïque','Floutez ou pixellisez certaines parties d’une photo.','Tout reste sur votre appareil.','ouvrir une image','charger depuis le presse-papiers','dessinez des cadres ou librement · réglez l’intensité par objet · faites glisser pour déplacer','mosaïque','flou','pinceau','supprimer l’objet','terminé','cadre (M)','main levée (B)','déplacer la vue / les objets (V)','annuler','rétablir','ajuster à l’écran','tout effacer','nouvelle image','copier l’image produite','enregistrer l’image','déposez l’image pour l’ouvrir'],
    he: ['censor — עורך טשטוש ופסיפס','טשטשו או פקסלו חלקים מתמונה.','הכול נשאר במכשיר שלך.','פתיחת תמונה','טעינה מהלוח','ציירו תיבות או באופן חופשי · כוונו עוצמה לכל אובייקט · גררו כדי להזיז','פסיפס','טשטוש','מברשת','מחיקת אובייקט','סיום','תיבה (M)','ציור חופשי (B)','הזזה / העברת אובייקטים (V)','ביטול','ביצוע חוזר','התאמה למסך','ניקוי הכול','תמונה חדשה','העתקת תמונת הפלט','שמירת תמונה','שחררו תמונה כדי לפתוח'],
    hi: ['censor — ब्लर और मोज़ेक संपादक','फ़ोटो के हिस्सों को धुंधला या पिक्सेलयुक्त करें।','सब कुछ आपके डिवाइस पर रहता है।','चित्र खोलें','क्लिपबोर्ड से लोड करें','बॉक्स या मुक्त रेखाएँ बनाएँ · हर ऑब्जेक्ट की तीव्रता बदलें · जगह बदलने के लिए खींचें','मोज़ेक','ब्लर','ब्रश','ऑब्जेक्ट हटाएँ','पूर्ण','बॉक्स (M)','मुक्तहस्त (B)','पैन / ऑब्जेक्ट खिसकाएँ (V)','पूर्ववत','फिर करें','स्क्रीन में फ़िट करें','सब साफ़ करें','नया चित्र','आउटपुट चित्र कॉपी करें','चित्र सहेजें','खोलने के लिए चित्र छोड़ें'],
    id: ['censor — editor buram & mosaik','Buramkan atau pikselkan bagian foto.','Semuanya tetap di perangkat Anda.','buka gambar','muat dari papan klip','gambar kotak atau bebas · atur kekuatan tiap objek · seret untuk memindahkan','mosaik','buram','kuas','hapus objek','selesai','kotak (M)','gambar bebas (B)','geser / pindahkan objek (V)','urungkan','ulangi','paskan ke layar','hapus semua','gambar baru','salin gambar hasil','simpan gambar','lepaskan gambar untuk membuka'],
    it: ['censor — editor sfocatura e mosaico','Sfoca o pixella parti di una foto.','Tutto rimane sul tuo dispositivo.','apri un’immagine','carica dagli appunti','disegna riquadri o a mano libera · regola l’intensità per oggetto · trascina per spostare','mosaico','sfocatura','pennello','elimina oggetto','fatto','riquadro (M)','mano libera (B)','sposta vista / oggetti (V)','annulla','ripeti','adatta allo schermo','cancella tutto','nuova immagine','copia immagine risultante','salva immagine','rilascia l’immagine per aprirla'],
    ja: ['censor — ぼかし・モザイク編集','写真の一部をぼかしたりモザイクにしたりできます。','画像はすべて端末内に保存されます。','画像を開く','クリップボードから読み込む','四角形またはフリーハンドで描画 · オブジェクトごとに強さを調整 · ドラッグして移動','モザイク','ぼかし','ブラシ','オブジェクトを削除','完了','四角形 (M)','フリーハンド (B)','表示 / オブジェクトを移動 (V)','元に戻す','やり直す','画面に合わせる','すべて消去','新しい画像','出力画像をコピー','画像を保存','画像をドロップして開く'],
    ko: ['censor — 흐림 및 모자이크 편집기','사진의 일부를 흐리게 하거나 모자이크 처리하세요.','모든 작업은 기기에만 저장됩니다.','이미지 열기','클립보드에서 불러오기','상자 또는 자유롭게 그리기 · 개체별 강도 조절 · 드래그하여 위치 이동','모자이크','흐림','브러시','개체 삭제','완료','상자 (M)','자유 그리기 (B)','화면 / 개체 이동 (V)','실행 취소','다시 실행','화면에 맞추기','모두 지우기','새 이미지','결과 이미지 복사','이미지 저장','이미지를 놓아 열기'],
    ms: ['censor — penyunting kabur & mozek','Kaburkan atau pikselkan bahagian foto.','Semuanya kekal pada peranti anda.','buka imej','muat dari papan klip','lukis kotak atau secara bebas · laraskan kekuatan setiap objek · seret untuk alih','mozek','kabur','berus','padam objek','selesai','kotak (M)','lukisan bebas (B)','sorot / alih objek (V)','buat asal','buat semula','muat pada skrin','kosongkan semua','imej baharu','salin imej output','simpan imej','lepaskan imej untuk membuka'],
    nl: ['censor — vervagings- en mozaïekeditor','Vervaag of pixel delen van een foto.','Alles blijft op je apparaat.','afbeelding openen','laden van klembord','teken vakken of vrij · pas sterkte per object aan · sleep om te verplaatsen','mozaïek','vervagen','penseel','object verwijderen','klaar','vak (M)','vrije hand (B)','beeld / objecten verplaatsen (V)','ongedaan maken','opnieuw','passend op scherm','alles wissen','nieuwe afbeelding','uitvoerafbeelding kopiëren','afbeelding opslaan','zet afbeelding neer om te openen'],
    no: ['censor — uskarphets- og mosaikkredigering','Gjør deler av et bilde uskarpe eller pikselerte.','Alt blir på enheten din.','åpne et bilde','last fra utklippstavlen','tegn bokser eller fritt · juster styrke per objekt · dra for å flytte','mosaikk','uskarphet','pensel','slett objekt','ferdig','boks (M)','frihånd (B)','panorer / flytt objekter (V)','angre','gjør om','tilpass til skjermen','tøm alt','nytt bilde','kopier resultatbildet','lagre bilde','slipp bildet for å åpne'],
    pl: ['censor — edytor rozmycia i mozaiki','Rozmyj lub spikselizuj fragmenty zdjęcia.','Wszystko pozostaje na Twoim urządzeniu.','otwórz obraz','wczytaj ze schowka','rysuj prostokąty lub odręcznie · ustaw siłę każdego obiektu · przeciągnij, aby przesunąć','mozaika','rozmycie','pędzel','usuń obiekt','gotowe','prostokąt (M)','odręcznie (B)','przesuń widok / obiekty (V)','cofnij','ponów','dopasuj do ekranu','wyczyść wszystko','nowy obraz','kopiuj obraz wynikowy','zapisz obraz','upuść obraz, aby otworzyć'],
    pt: ['censor — editor de desfoque e mosaico','Desfoque ou pixelize partes de uma foto.','Tudo permanece no seu dispositivo.','abrir uma imagem','carregar da área de transferência','desenhe caixas ou livremente · ajuste a intensidade por objeto · arraste para mover','mosaico','desfoque','pincel','excluir objeto','concluir','caixa (M)','mão livre (B)','mover vista / objetos (V)','desfazer','refazer','ajustar à tela','limpar tudo','nova imagem','copiar imagem resultante','salvar imagem','solte a imagem para abrir'],
    ro: ['censor — editor de estompare și mozaic','Estompați sau pixelizați părți dintr-o fotografie.','Totul rămâne pe dispozitivul dvs.','deschide o imagine','încarcă din clipboard','desenați casete sau liber · reglați intensitatea fiecărui obiect · trageți pentru mutare','mozaic','estompare','pensulă','șterge obiectul','gata','casetă (M)','desen liber (B)','panoramare / mutare obiecte (V)','anulează','refă','potrivește pe ecran','șterge tot','imagine nouă','copiază imaginea rezultată','salvează imaginea','plasați imaginea pentru a o deschide'],
    ru: ['censor — редактор размытия и мозаики','Размывайте или пикселизируйте части фотографии.','Всё остаётся на вашем устройстве.','открыть изображение','загрузить из буфера обмена','рисуйте прямоугольники или от руки · настраивайте силу каждого объекта · перетаскивайте для перемещения','мозаика','размытие','кисть','удалить объект','готово','прямоугольник (M)','от руки (B)','панорама / перемещение объектов (V)','отменить','повторить','вписать в экран','очистить всё','новое изображение','копировать результат','сохранить изображение','перетащите изображение, чтобы открыть'],
    sv: ['censor — oskärpe- och mosaikredigerare','Gör delar av ett foto suddiga eller pixliga.','Allt stannar på din enhet.','öppna en bild','läs in från urklipp','rita rutor eller fritt · justera styrka per objekt · dra för att flytta','mosaik','oskärpa','pensel','ta bort objekt','klar','ruta (M)','frihand (B)','panorera / flytta objekt (V)','ångra','gör om','anpassa till skärmen','rensa allt','ny bild','kopiera resultatbild','spara bild','släpp bilden för att öppna'],
    th: ['censor — เครื่องมือเบลอและโมเสก','เบลอหรือทำภาพเป็นพิกเซลเฉพาะส่วน','ทุกอย่างอยู่บนอุปกรณ์ของคุณ','เปิดรูปภาพ','โหลดจากคลิปบอร์ด','วาดกรอบหรือวาดอิสระ · ปรับความแรงแต่ละวัตถุ · ลากเพื่อย้าย','โมเสก','เบลอ','แปรง','ลบวัตถุ','เสร็จ','กรอบ (M)','วาดอิสระ (B)','เลื่อน / ย้ายวัตถุ (V)','เลิกทำ','ทำซ้ำ','พอดีหน้าจอ','ล้างทั้งหมด','รูปภาพใหม่','คัดลอกรูปผลลัพธ์','บันทึกรูปภาพ','วางรูปเพื่อเปิด'],
    tr: ['censor — bulanıklık ve mozaik düzenleyici','Fotoğrafın bölümlerini bulanıklaştırın veya pikselleştirin.','Her şey cihazınızda kalır.','görsel aç','panodan yükle','kutular veya serbest çizgiler çizin · her nesnenin gücünü ayarlayın · taşımak için sürükleyin','mozaik','bulanıklık','fırça','nesneyi sil','bitti','kutu (M)','serbest çizim (B)','kaydır / nesneleri taşı (V)','geri al','yinele','ekrana sığdır','tümünü temizle','yeni görsel','çıktı görselini kopyala','görseli kaydet','açmak için görseli bırakın'],
    uk: ['censor — редактор розмиття й мозаїки','Розмивайте або пікселізуйте частини фотографії.','Усе залишається на вашому пристрої.','відкрити зображення','завантажити з буфера обміну','малюйте прямокутники або від руки · налаштовуйте силу кожного об’єкта · перетягуйте для переміщення','мозаїка','розмиття','пензель','видалити об’єкт','готово','прямокутник (M)','від руки (B)','панорама / переміщення об’єктів (V)','скасувати','повторити','підігнати до екрана','очистити все','нове зображення','копіювати результат','зберегти зображення','перетягніть зображення, щоб відкрити'],
    ur: ['censor — دھندلا اور موزیک ایڈیٹر','تصویر کے حصوں کو دھندلا یا پکسل کریں۔','سب کچھ آپ کے آلے پر رہتا ہے۔','تصویر کھولیں','کلپ بورڈ سے لوڈ کریں','خانے یا آزادانہ لکیریں بنائیں · ہر شے کی شدت بدلیں · منتقل کرنے کے لیے کھینچیں','موزیک','دھندلا','برش','شے حذف کریں','مکمل','خانہ (M)','آزادانہ (B)','منظر / اشیا منتقل کریں (V)','واپس','دوبارہ','اسکرین پر فٹ کریں','سب صاف کریں','نئی تصویر','نتیجہ تصویر کاپی کریں','تصویر محفوظ کریں','کھولنے کے لیے تصویر چھوڑیں'],
    vi: ['censor — trình chỉnh sửa làm mờ & khảm','Làm mờ hoặc tạo điểm ảnh cho một phần ảnh.','Mọi thứ đều ở lại trên thiết bị của bạn.','mở ảnh','tải từ bảng nhớ tạm','vẽ khung hoặc tự do · chỉnh độ mạnh từng đối tượng · kéo để di chuyển','khảm','làm mờ','cọ','xóa đối tượng','xong','khung (M)','vẽ tự do (B)','di chuyển khung nhìn / đối tượng (V)','hoàn tác','làm lại','vừa màn hình','xóa tất cả','ảnh mới','sao chép ảnh kết quả','lưu ảnh','thả ảnh để mở'],
    'zh-hans': ['censor — 模糊与马赛克编辑器','模糊或像素化照片的部分区域。','所有内容都保留在你的设备上。','打开图片','从剪贴板加载','绘制矩形或自由涂画 · 单独调整每个对象的强度 · 拖动以移动','马赛克','模糊','画笔','删除对象','完成','矩形 (M)','自由绘制 (B)','平移 / 移动对象 (V)','撤销','重做','适应屏幕','全部清除','新图片','复制输出图片','保存图片','拖放图片以打开'],
    'zh-hant': ['censor — 模糊與馬賽克編輯器','模糊或像素化照片的部分區域。','所有內容都保留在你的裝置上。','開啟圖片','從剪貼簿載入','繪製矩形或自由塗畫 · 個別調整每個物件的強度 · 拖曳以移動','馬賽克','模糊','筆刷','刪除物件','完成','矩形 (M)','自由繪製 (B)','平移 / 移動物件 (V)','復原','重做','符合螢幕','全部清除','新圖片','複製輸出圖片','儲存圖片','拖放圖片以開啟'],
  };

  const alertRows = {
    de: ['Das Bild konnte nicht geöffnet werden.','Lege hier eine Bilddatei ab.','Aktuelles Bild ersetzen? Deine Bearbeitungen und der Rückgängig-Verlauf gehen verloren.','Die Zwischenablage enthält kein Bild.','Der Zugriff auf die Zwischenablage ist hier nicht verfügbar. Versuche Cmd/Strg+V.','Der Zugriff auf die Zwischenablage wurde blockiert. Versuche Cmd/Strg+V.','Alle Zensurobjekte entfernen?','Neues Bild öffnen? Deine Bearbeitungen und der Rückgängig-Verlauf gehen verloren.','Dieser Browser unterstützt das Kopieren von Bildern nicht.','Ausgabebild in die Zwischenablage kopiert.','Das Bild konnte nicht kopiert werden. Prüfe die Zwischenablageberechtigung und versuche es erneut.','Das Bild konnte nicht gespeichert werden.'],
    es: ['No se pudo abrir esa imagen.','Suelta aquí un archivo de imagen.','¿Reemplazar la imagen actual? Se perderán tus cambios y el historial.','El portapapeles no contiene una imagen.','El acceso al portapapeles no está disponible aquí. Prueba Cmd/Ctrl+V.','Se bloqueó el acceso al portapapeles. Prueba Cmd/Ctrl+V.','¿Eliminar todos los objetos de censura?','¿Abrir una imagen nueva? Se perderán tus cambios y el historial.','Este navegador no permite copiar imágenes.','Imagen resultante copiada al portapapeles.','No se pudo copiar la imagen. Comprueba el permiso del portapapeles e inténtalo de nuevo.','No se pudo guardar la imagen.'],
    fr: ['Impossible d’ouvrir cette image.','Déposez un fichier image ici.','Remplacer l’image actuelle ? Vos modifications et l’historique seront perdus.','Le presse-papiers ne contient pas d’image.','L’accès au presse-papiers n’est pas disponible ici. Essayez Cmd/Ctrl+V.','L’accès au presse-papiers a été bloqué. Essayez Cmd/Ctrl+V.','Supprimer tous les objets de censure ?','Ouvrir une nouvelle image ? Vos modifications et l’historique seront perdus.','Ce navigateur ne permet pas de copier des images.','Image produite copiée dans le presse-papiers.','Impossible de copier l’image. Vérifiez l’autorisation du presse-papiers et réessayez.','Impossible d’enregistrer l’image.'],
    ja: ['画像を開けませんでした。','画像ファイルをここにドロップしてください。','現在の画像を置き換えますか？編集内容と履歴は失われます。','クリップボードに画像がありません。','ここではクリップボードにアクセスできません。Cmd/Ctrl+V をお試しください。','クリップボードへのアクセスが拒否されました。Cmd/Ctrl+V をお試しください。','すべての加工オブジェクトを削除しますか？','新しい画像を開きますか？編集内容と履歴は失われます。','このブラウザは画像のコピーに対応していません。','出力画像をクリップボードにコピーしました。','画像をコピーできませんでした。クリップボードの権限を確認して、もう一度お試しください。','画像を保存できませんでした。'],
    ko: ['이미지를 열 수 없습니다.','여기에 이미지 파일을 놓으세요.','현재 이미지를 바꿀까요? 편집 내용과 실행 취소 기록이 사라집니다.','클립보드에 이미지가 없습니다.','여기서는 클립보드에 접근할 수 없습니다. Cmd/Ctrl+V를 사용해 보세요.','클립보드 접근이 차단되었습니다. Cmd/Ctrl+V를 사용해 보세요.','모든 검열 개체를 삭제할까요?','새 이미지를 열까요? 편집 내용과 실행 취소 기록이 사라집니다.','이 브라우저에서는 이미지를 복사할 수 없습니다.','결과 이미지를 클립보드에 복사했습니다.','이미지를 복사할 수 없습니다. 클립보드 권한을 확인하고 다시 시도하세요.','이미지를 저장할 수 없습니다.'],
    pt: ['Não foi possível abrir essa imagem.','Solte um arquivo de imagem aqui.','Substituir a imagem atual? Suas edições e o histórico serão perdidos.','A área de transferência não contém uma imagem.','O acesso à área de transferência não está disponível aqui. Tente Cmd/Ctrl+V.','O acesso à área de transferência foi bloqueado. Tente Cmd/Ctrl+V.','Remover todos os objetos de censura?','Abrir uma nova imagem? Suas edições e o histórico serão perdidos.','Este navegador não permite copiar imagens.','Imagem resultante copiada para a área de transferência.','Não foi possível copiar a imagem. Verifique a permissão da área de transferência e tente novamente.','Não foi possível salvar a imagem.'],
    ru: ['Не удалось открыть изображение.','Перетащите сюда файл изображения.','Заменить текущее изображение? Изменения и история будут потеряны.','В буфере обмена нет изображения.','Доступ к буферу обмена здесь недоступен. Попробуйте Cmd/Ctrl+V.','Доступ к буферу обмена заблокирован. Попробуйте Cmd/Ctrl+V.','Удалить все объекты цензуры?','Открыть новое изображение? Изменения и история будут потеряны.','Этот браузер не поддерживает копирование изображений.','Результат скопирован в буфер обмена.','Не удалось скопировать изображение. Проверьте разрешение буфера обмена и повторите попытку.','Не удалось сохранить изображение.'],
    'zh-hans': ['无法打开该图片。','请将图片文件拖放到这里。','要替换当前图片吗？当前编辑和撤销历史将丢失。','剪贴板中没有图片。','此处无法访问剪贴板。请尝试 Cmd/Ctrl+V。','剪贴板访问被阻止。请尝试 Cmd/Ctrl+V。','要移除所有遮挡对象吗？','要打开新图片吗？当前编辑和撤销历史将丢失。','此浏览器不支持复制图片。','输出图片已复制到剪贴板。','无法复制图片。请检查剪贴板权限后重试。','无法保存图片。'],
    'zh-hant': ['無法開啟該圖片。','請將圖片檔案拖放到這裡。','要取代目前圖片嗎？目前的編輯和復原記錄將會遺失。','剪貼簿中沒有圖片。','此處無法存取剪貼簿。請嘗試 Cmd/Ctrl+V。','剪貼簿存取遭到封鎖。請嘗試 Cmd/Ctrl+V。','要移除所有遮蔽物件嗎？','要開啟新圖片嗎？目前的編輯和復原記錄將會遺失。','此瀏覽器不支援複製圖片。','輸出圖片已複製到剪貼簿。','無法複製圖片。請檢查剪貼簿權限後再試一次。','無法儲存圖片。'],
  };

  const alertKeys = [
    'openFailed', 'dropImageOnly', 'replaceConfirm', 'clipboardEmpty',
    'clipboardUnavailable', 'clipboardBlocked', 'clearConfirm', 'newImageConfirm',
    'copyUnsupported', 'copySuccess', 'copyFailed', 'saveFailed',
  ];

  const catalogs = { en: english };
  for (const [locale, row] of Object.entries(coreRows)) {
    catalogs[locale] = Object.fromEntries(coreKeys.map((key, i) => [key, row[i]]));
  }
  for (const [locale, row] of Object.entries(alertRows)) {
    Object.assign(catalogs[locale], Object.fromEntries(alertKeys.map((key, i) => [key, row[i]])));
  }

  function resolveLocale() {
    const aliases = { in: 'id', iw: 'he', nb: 'no', nn: 'no' };
    for (const requested of navigator.languages || [navigator.language || 'en']) {
      const locale = requested.toLowerCase();
      if (locale === 'zh' || locale.startsWith('zh-')) {
        const traditional = /-(tw|hk|mo|hant)(-|$)/.test(locale);
        return traditional ? 'zh-hant' : 'zh-hans';
      }
      if (catalogs[locale]) return locale;
      const base = locale.split('-')[0];
      if (catalogs[base]) return base;
      if (catalogs[aliases[base]]) return aliases[base];
    }
    return 'en';
  }

  const locale = resolveLocale();
  const rtl = new Set(['ar', 'fa', 'he', 'ur']);

  function t(key) {
    return catalogs[locale]?.[key] || english[key] || key;
  }

  document.documentElement.lang = locale;
  document.documentElement.dir = rtl.has(locale) ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i18n]').forEach(element => {
    element.textContent = t(element.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(element => {
    const label = t(element.dataset.i18nTitle);
    element.title = label;
    element.setAttribute('aria-label', label);
  });
  document.body.dataset.dropLabel = t('dropOpen');

  window.i18n = Object.freeze({ locale, t });
})();
