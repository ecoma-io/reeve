/**
 * Reeve's own words, wherever they wrap a thread's content — the boundary
 * notes, the footers, the fixed scaffolding around a translation, a first
 * reply, a duplicate proposal, a lifecycle nudge. Never a duty's judgement,
 * never a model's output: everything below is a string this file commits and
 * a reviewer reads in the diff, the same as any other line of code.
 *
 * **Zero model calls, ever, for any of this.** A repository whose
 * `languages:` includes a code this table has no row for gets the English
 * row instead — deterministically, the same choice on every run, never a
 * request spent guessing at a translation of two sentences of scaffolding.
 * See `docs/concepts/language-layer.md`'s chrome section for why that is a
 * different question from whether a *duty* can translate a thread's content
 * into that language.
 *
 * **Chrome follows the language of the block it wraps.** Every block a duty
 * publishes belongs to one language throughout — a lifecycle comment resolved
 * to the thread's own language, a first reply, a duplicate proposal, and each
 * of `translate`'s collapsible sections, whose boundary note and footer sit
 * inside the section they describe — so its chrome renders in that same
 * language, via {@link chrome}, and never picks a single language to speak
 * *about* another in.
 *
 * **Adding a language is one pull request, touching only this file.** A new
 * entry in {@link CHROME_LANGUAGES}, a full row of translations for it added
 * to every key in {@link CHROME}, and `chrome.test.ts`'s completeness test —
 * which checks every key against every configured language — fails loudly at
 * that same pull request if a single key was missed.
 */

/** A language this file has its own row for. Extending this is the whole of "adding a language". */
export type ChromeLanguage =
  | "ar"
  | "cs"
  | "de"
  | "en"
  | "es"
  | "fr"
  | "hi"
  | "id"
  | "it"
  | "ja"
  | "ko"
  | "nl"
  | "pl"
  | "pt"
  | "ru"
  | "sv"
  | "th"
  | "tr"
  | "uk"
  | "vi"
  | "zh";

/** Every language {@link CHROME} has a row for, English first. */
export const CHROME_LANGUAGES: readonly ChromeLanguage[] = [
  "en",
  "ar",
  "cs",
  "de",
  "es",
  "fr",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "pl",
  "pt",
  "ru",
  "sv",
  "th",
  "tr",
  "uk",
  "vi",
  "zh",
];

type Row = Readonly<Record<ChromeLanguage, string>>;

/**
 * The whole committed table, one row per chrome string, one column per
 * language. `{name}` inside a value is a placeholder {@link chrome}
 * substitutes from its `params` argument — see its doc comment for what
 * happens when a placeholder is left unfilled.
 */
const CHROME = {
  // translate/publish.ts — each language's collapsible section carries its
  // own boundary note and footer inside it, in that section's language.
  translateBoundary: {
    en: "**The text above is the original, and it is the version this project answers for.** Everything below is a machine translation by [Reeve](https://github.com/ecoma-io/reeve). Where the two disagree, the text above is the one that counts.",
    ar: "**النص أعلاه هو النص الأصلي، وهو النسخة التي يستند إليها هذا المشروع.** كل ما أدناه هو ترجمة آلية بواسطة [Reeve](https://github.com/ecoma-io/reeve). في حال اختلاف النصين، يكون النص أعلاه هو المعتمد.",
    cs: "**Text výše je originál a je verzí, na kterou se tento projekt odvolává.** Vše níže je strojový překlad od [Reeve](https://github.com/ecoma-io/reeve). Pokud se oba neshodují, platí text výše.",
    de: "**Der obige Text ist das Original und die Version, für die dieses Projekt verantwortlich ist.** Alles unten ist eine maschinelle Übersetzung von [Reeve](https://github.com/ecoma-io/reeve). Wenn die beiden voneinander abweichen, ist der obige Text maßgeblich.",
    es: "**El texto anterior es el original y es la versión que este proyecto respalda.** Todo lo que sigue es una traducción automática de [Reeve](https://github.com/ecoma-io/reeve). Cuando haya discrepancia entre ambos, el texto anterior es el que prevalece.",
    fr: "**Le texte ci-dessus est l'original, et c'est la version faisant autorité pour ce projet.** Tout ce qui suit est une traduction automatique par [Reeve](https://github.com/ecoma-io/reeve). En cas de divergence entre les deux, le texte ci-dessus fait foi.",
    hi: "**ऊपर का पाठ मूल है, और यही वह संस्करण है जिसके आधार पर यह परियोजना कार्य करती है।** नीचे का सब कुछ [Reeve](https://github.com/ecoma-io/reeve) द्वारा मशीनी अनुवाद है। जहाँ दोनों में अंतर हो, ऊपर का पाठ मान्य माना जाएगा।",
    id: "**Teks di atas adalah teks asli, dan merupakan versi yang menjadi acuan proyek ini.** Semua di bawah ini adalah terjemahan mesin oleh [Reeve](https://github.com/ecoma-io/reeve). Jika terdapat perbedaan, teks di atas yang berlaku.",
    it: "**Il testo sopra è l'originale ed è la versione di riferimento per questo progetto.** Tutto ciò che segue è una traduzione automatica di [Reeve](https://github.com/ecoma-io/reeve). In caso di discordanza tra i due, il testo sopra è quello che conta.",
    ja: "**上のテキストが原文であり、本プロジェクトが基準とするバージョンです。** 以下はすべて[Reeve](https://github.com/ecoma-io/reeve)による機械翻訳です。両者が異なる場合、上のテキストが優先されます。",
    ko: "**위 텍스트가 원문이며, 본 프로젝트가 기준으로 삼는 버전입니다.** 아래는 모두 [Reeve](https://github.com/ecoma-io/reeve)의 기계 번역입니다. 두 내용이 일치하지 않을 경우, 위 텍스트가 우선합니다.",
    nl: "**De tekst hierboven is het origineel en is de versie waarvoor dit project instaat.** Alles hieronder is een machinale vertaling door [Reeve](https://github.com/ecoma-io/reeve). Wanneer de twee van elkaar afwijken, is de tekst hierboven leidend.",
    pl: "**Tekst powyżej jest oryginałem i jest wersją, do której odnosi się ten projekt.** Wszystko poniżej to tłumaczenie maszynowe wykonane przez [Reeve](https://github.com/ecoma-io/reeve). W przypadku rozbieżności tekst powyżej jest wiążący.",
    pt: "**O texto acima é o original e é a versão pela qual este projeto se responsabiliza.** Tudo abaixo é uma tradução automática de [Reeve](https://github.com/ecoma-io/reeve). Em caso de divergência entre os dois, o texto acima é o que prevalece.",
    ru: "**Текст выше является оригиналом и версией, на которую ориентируется данный проект.** Всё ниже — машинный перевод от [Reeve](https://github.com/ecoma-io/reeve). В случае расхождений приоритет имеет текст выше.",
    sv: "**Texten ovan är originalet och den version som detta projekt utgår från.** Allt nedan är en maskinöversättning av [Reeve](https://github.com/ecoma-io/reeve). Om de två skiljer sig åt gäller texten ovan.",
    th: "**ข้อความด้านบนคือต้นฉบับ และเป็นเวอร์ชันที่โปรเจกต์นี้ใช้อ้างอิง** ทุกอย่างด้านล่างนี้เป็นคำแปลอัตโนมัติโดย [Reeve](https://github.com/ecoma-io/reeve) หากมีความขัดแย้ง ให้ถือเอาข้อความด้านบนเป็นที่ถูกต้อง",
    tr: "**Yukarıdaki metin asıl metindir ve bu projenin dayandığı sürümdür.** Aşağıdaki her şey [Reeve](https://github.com/ecoma-io/reeve) tarafından yapılan makine çevirisidir. İkisi arasında çelişki olduğunda, yukarıdaki metin geçerlidir.",
    uk: "**Текст вище є оригіналом і версією, на яку орієнтується цей проект.** Усе нижче — машинний переклад від [Reeve](https://github.com/ecoma-io/reeve). У разі розбіжностей пріоритет має текст вище.",
    vi: "**Văn bản phía trên là bản gốc, và đây là phiên bản mà dự án này chịu trách nhiệm về nội dung.** Mọi nội dung phía dưới là bản dịch máy do [Reeve](https://github.com/ecoma-io/reeve) thực hiện. Khi hai bên khác nhau, văn bản phía trên mới là bản có giá trị.",
    zh: "**上面的文本是原文，这个项目对其内容负责。** 以下所有内容均由 [Reeve](https://github.com/ecoma-io/reeve) 机器翻译。如有出入，以上面的文本为准。",
  },
  translateFooterFrom: {
    en: "Translated from {label}.",
    ar: "تُرجم من {label}.",
    cs: "Přeloženo z {label}.",
    de: "Übersetzt aus {label}.",
    es: "Traducido de {label}.",
    fr: "Traduit depuis {label}.",
    hi: "{label} से अनूदित।",
    id: "Diterjemahkan dari {label}.",
    it: "Tradotto da {label}.",
    ja: "{label}から翻訳しました。",
    ko: "{label}에서 번역했습니다.",
    nl: "Vertaald van {label}.",
    pl: "Przetłumaczono z {label}.",
    pt: "Traduzido de {label}.",
    ru: "Исходный язык: {label}.",
    sv: "Översatt från {label}.",
    th: "แปลจาก {label}",
    tr: "{label} dilinden çevrilmiştir.",
    uk: "Вихідна мова: {label}.",
    vi: "Được dịch từ {label}.",
    zh: "翻译自 {label}。",
  },
  translateFooterTruncated: {
    en: "The body was longer than this run's limit, so its tail was not translated.",
    ar: "تجاوز النص حدّ هذا التشغيل، لذا لم تُترجم نهايته.",
    cs: "Obsah byl delší než limit tohoto spuštění, proto jeho konec nebyl přeložen.",
    de: "Der Textkörper war länger als das Limit dieses Durchlaufs, daher wurde sein Ende nicht übersetzt.",
    es: "El cuerpo superaba el límite de esta ejecución, por lo que su parte final no fue traducida.",
    fr: "Le corps dépassait la limite de cette exécution, sa fin n'a donc pas été traduite.",
    hi: "मुख्य भाग इस चलाने की सीमा से अधिक लंबा था, इसलिए उसका अंत अनुवादित नहीं किया गया।",
    id: "Isi lebih panjang dari batas operasi ini, sehingga bagian akhirnya tidak diterjemahkan.",
    it: "Il corpo superava il limite di questa esecuzione, quindi la parte finale non è stata tradotta.",
    ja: "本文が今回の実行制限を超えたため、末尾は翻訳されませんでした。",
    ko: "본문이 이번 실행 제한을 초과하여 끝부분이 번역되지 않았습니다.",
    nl: "De hoofdtekst was langer dan de limiet van deze run, daarom is het einde niet vertaald.",
    pl: "Treść przekroczyła limit tego uruchomienia, dlatego końcówka nie została przetłumaczona.",
    pt: "O corpo excedia o limite desta execução, portanto sua parte final não foi traduzida.",
    ru: "Текст превысил лимит текущего запуска, поэтому конец не был переведён.",
    sv: "Texten var längre än gränsen för denna körning, så slutet översattes inte.",
    th: "เนื้อหายาวเกินขีดจำกัดของการทำงานครั้งนี้ จึงไม่ได้แปลส่วนท้าย",
    tr: "Gövde bu çalışmanın sınırından uzun olduğundan, son kısmı çevrilmemiştir.",
    uk: "Текст перевищив ліміт цього запуску, тому кінець не було перекладено.",
    vi: "Nội dung dài hơn giới hạn của lần chạy này, nên phần cuối chưa được dịch.",
    zh: "正文长度超过本次运行的限制，末尾部分未被翻译。",
  },
  translateFooterSkipped: {
    en: "Not translated this run: {list}.",
    ar: "لم تُترجم في هذا التشغيل: {list}.",
    cs: "Nepřeloženo v tomto spuštění: {list}.",
    de: "In diesem Durchlauf nicht übersetzt: {list}.",
    es: "No traducido en esta ejecución: {list}.",
    fr: "Non traduit lors de cette exécution : {list}.",
    hi: "इस चलाने में अनुवादित नहीं: {list}।",
    id: "Tidak diterjemahkan pada operasi ini: {list}.",
    it: "Non tradotto in questa esecuzione: {list}.",
    ja: "今回翻訳対象外: {list}。",
    ko: "이번 실행에서 번역되지 않음: {list}.",
    nl: "Niet vertaald in deze run: {list}.",
    pl: "Nie przetłumaczono w tym uruchomieniu: {list}.",
    pt: "Não traduzido nesta execução: {list}.",
    ru: "Не переведено в этом запуске: {list}.",
    sv: "Ej översatt i denna körning: {list}.",
    th: "ไม่ได้แปลในการทำงานครั้งนี้: {list}",
    tr: "Bu çalışmada çevrilmeyenler: {list}.",
    uk: "Не перекладено в цьому запуску: {list}.",
    vi: "Chưa được dịch trong lần chạy này: {list}.",
    zh: "本次运行未翻译：{list}。",
  },
  translateFooterEditable: {
    en: "Editing the text above republishes this; deleting this block regenerates it.",
    ar: "تعديل النص أعلاه يعيد نشر هذا؛ حذف هذه الكتلة يعيد توليده.",
    cs: "Úprava textu výše tento blok znovu zveřejní; smazání tohoto bloku jej znovu vygeneruje.",
    de: "Die Bearbeitung des obigen Textes veröffentlicht dies erneut; das Löschen dieses Blocks erstellt es neu.",
    es: "Editar el texto anterior republica esto; eliminar este bloque lo regenera.",
    fr: "Modifier le texte ci-dessus republie ceci ; supprimer ce bloc le régénère.",
    hi: "ऊपर के पाठ को संपादित करने से यह पुनः प्रकाशित होता है; इस खंड को हटाने से यह पुनः उत्पन्न होता है।",
    id: "Menyunting teks di atas akan menerbitkan ulang ini; menghapus blok ini akan membuatnya ulang.",
    it: "La modifica del testo sopra ripubblica questo; l'eliminazione di questo blocco lo rigenera.",
    ja: "上のテキストを編集すると再公開されます。このブロックを削除すると再生成されます。",
    ko: "위 텍스트를 편집하면 다시 게시됩니다. 이 블록을 삭제하면 다시 생성됩니다.",
    nl: "De tekst hierboven bewerken herpubliceert dit; dit blok verwijderen genereert het opnieuw.",
    pl: "Edycja tekstu powyżej ponownie publikuje ten blok; usunięcie go powoduje jego ponowne wygenerowanie.",
    pt: "Editar o texto acima republica isto; excluir este bloco o regenera.",
    ru: "Редактирование текста выше переопубликует его; удаление этого блока приведёт к повторной генерации.",
    sv: "Att redigera texten ovan publicerar detta på nytt; att ta bort detta block återskapar det.",
    th: "การแก้ไขข้อความด้านบนจะเผยแพร่ส่วนนี้ซ้ำ การลบบล็อกนี้จะสร้างใหม่",
    tr: "Yukarıdaki metni düzenlemek bunu yeniden yayımlar; bu bloğu silmek bunu yeniden oluşturur.",
    uk: "Редагування тексту вище переопублікує його; видалення цього блоку призведе до повторної генерації.",
    vi: "Chỉnh sửa văn bản phía trên sẽ đăng lại bản dịch này; xóa khối này sẽ tạo lại nó.",
    zh: "编辑上面的文本会重新发布此翻译；删除此区块会重新生成它。",
  },

  // lifecycle/message.ts's footer() — every line below already sits under a
  // comment `renderSay`/`renderClose` already resolved to one language. The
  // zh row keeps the same register as `lifecycle/message.ts`'s own `BUILTIN_REMINDER`/
  // `BUILTIN_CLOSE` — "重新开始计时" for "restarts the clock" — so a lifecycle
  // comment reads as one voice, not two translators.
  lifecycleFooterResetsAuthor: {
    en: "A reply from this thread's author restarts the clock.",
    ar: "ردّ من صاحب هذا النقاش يعيد تشغيل المؤقت.",
    cs: "Odpověď autora tohoto vlákna restartuje časovač.",
    de: "Eine Antwort des Autors dieses Threads setzt die Frist zurück.",
    es: "Una respuesta del autor de este hilo reinicia el plazo.",
    fr: "Une réponse de l'auteur de ce fil relance le délai.",
    hi: "इस थ्रेड के लेखक का उत्तर घड़ी पुनः आरंभ करता है।",
    id: "Balasan dari penulis utas ini mengatur ulang waktu.",
    it: "Una risposta dall'autore di questa discussione riavvia il conteggio.",
    ja: "スレッドの作成者が返信すると、タイマーがリセットされます。",
    ko: "스레드 작성자가 답글하면 타이머가 초기화됩니다.",
    nl: "Een antwoord van de auteur van deze thread begint de termijn opnieuw.",
    pl: "Odpowiedź autora tego wątku resetuje licznik.",
    pt: "Uma resposta do autor deste tópico reinicia o prazo.",
    ru: "Ответ от автора потока сбрасывает таймер.",
    sv: "Ett svar från trådens författare startar om klockan.",
    th: "การตอบกลับจากผู้เขียนของเธรดนี้จะเริ่มตัวนับเวลาใหม่",
    tr: "Bu iş parçacığının yazarından gelen bir yanıt sayacı sıfırlar.",
    uk: "Відповідь від автора потоку скидає таймер.",
    vi: "Một phản hồi từ tác giả của chủ đề này sẽ khởi động lại đồng hồ.",
    zh: "此话题作者的回复会重新开始计时。",
  },
  lifecycleFooterResetsAny: {
    en: "Any activity here restarts the clock.",
    ar: "أي نشاط هنا يعيد تشغيل المؤقت.",
    cs: "Jakákoli aktivita zde restartuje časovač.",
    de: "Jegliche Aktivität hier setzt die Frist zurück.",
    es: "Cualquier actividad aquí reinicia el plazo.",
    fr: "Toute activité ici relance le délai.",
    hi: "यहाँ कोई भी गतिविधि घड़ी पुनः आरंभ करती है।",
    id: "Aktivitas apa pun di sini mengatur ulang waktu.",
    it: "Qualsiasi attività qui riavvia il conteggio.",
    ja: "ここでの任意のアクティビティにより、タイマーがリセットされます。",
    ko: "여기에서 활동이 발생하면 타이머가 초기화됩니다.",
    nl: "Elke activiteit hier begint de termijn opnieuw.",
    pl: "Dowolna aktywność tutaj resetuje licznik.",
    pt: "Qualquer atividade aqui reinicia o prazo.",
    ru: "Любая активность здесь сбрасывает таймер.",
    sv: "All aktivitet här startar om klockan.",
    th: "กิจกรรมใดๆ ที่นี่จะเริ่มตัวนับเวลาใหม่",
    tr: "Buradaki herhangi bir etkinlik sayacı sıfırlar.",
    uk: "Будь-яка активність тут скидає таймер.",
    vi: "Bất kỳ hoạt động nào ở đây cũng sẽ khởi động lại đồng hồ.",
    zh: "这里的任何活动都会重新开始计时。",
  },
  lifecycleFooterWhenLabel: {
    en: "Removing the `{label}` label also stops this track.",
    ar: "إزالة التصنيف `{label}` يوقف أيضًا هذا المسار.",
    cs: "Odebrání štítku `{label}` také zastaví tento sled.",
    de: "Das Entfernen des Labels `{label}` stoppt diesen Ablauf ebenfalls.",
    es: "Eliminar la etiqueta `{label}` también detiene este seguimiento.",
    fr: "Retirer le label `{label}` arrête également ce suivi.",
    hi: "`{label}` लेबल हटाने से यह ट्रैक भी रुकता है।",
    id: "Menghapus label `{label}` juga menghentikan pelacakan ini.",
    it: "Rimuovere l'etichetta `{label}` interrompe anche questa traccia.",
    ja: "`{label}`ラベルを削除すると、このトラックも停止します。",
    ko: "`{label}` 라벨을 제거하면 이 트랙도 중지됩니다.",
    nl: "Het label `{label}` verwijderen stopt deze volging ook.",
    pl: "Usunięcie etykiety `{label}` również zatrzymuje ten ślad.",
    pt: "Remover o rótulo `{label}` também interrompe este acompanhamento.",
    ru: "Удаление метки `{label}` также останавливает этот процесс.",
    sv: "Att ta bort etiketten `{label}` stoppar även detta spår.",
    th: "การลบป้ายกำกับ `{label}` จะหยุดแทร็กนี้ด้วย",
    tr: "`{label}` etiketini kaldırmak bu izlemeyi de durdurur.",
    uk: "Видалення мітки `{label}` також зупиняє цей процес.",
    vi: "Gỡ nhãn `{label}` cũng sẽ dừng track này.",
    zh: "移除 `{label}` 标签也会停止此跟踪。",
  },
  lifecycleFooterEscape: {
    en: "Adding `{label}` stops this permanently.",
    ar: "إضافة `{label}` يوقف هذا نهائيًا.",
    cs: "Přidání `{label}` to trvale zastaví.",
    de: "Das Hinzufügen von `{label}` stoppt dies dauerhaft.",
    es: "Añadir `{label}` detiene esto permanentemente.",
    fr: "Ajouter `{label}` arrête ceci de façon permanente.",
    hi: "`{label}` जोड़ने से यह स्थायी रूप से रुकता है।",
    id: "Menambahkan `{label}` menghentikan ini secara permanen.",
    it: "Aggiungere `{label}` interrompe questo in modo permanente.",
    ja: "`{label}`を追加すると、これを永久に停止します。",
    ko: "`{label}` 추가 시 영구적으로 중지됩니다.",
    nl: "`{label}` toevoegen stopt dit permanent.",
    pl: "Dodanie `{label}` trwale zatrzymuje ten proces.",
    pt: "Adicionar `{label}` interrompe isto permanentemente.",
    ru: "Добавление `{label}` навсегда останавливает этот процесс.",
    sv: "Att lägga till `{label}` stoppar detta permanent.",
    th: "การเพิ่ม `{label}` จะหยุดสิ่งนี้อย่างถาวร",
    tr: "`{label}` eklemek bunu kalıcı olarak durdurur.",
    uk: "Додавання `{label}` назавжди зупиняє цей процес.",
    vi: "Thêm nhãn `{label}` sẽ dừng việc này vĩnh viễn.",
    zh: "添加 `{label}` 会永久停止此操作。",
  },
  lifecycleFooterAttribution: {
    en: "lifecycle — a policy this repository's own warrant configured.",
    ar: "lifecycle — سياسة ضبطها warrant الخاص بهذا المستودع.",
    cs: "lifecycle — zásada nakonfigurovaná warrantem tohoto repozitáře.",
    de: "lifecycle — eine Richtlinie, die der eigene Warrant dieses Repositorys konfiguriert hat.",
    es: "lifecycle — una política configurada por el warrant de este repositorio.",
    fr: "lifecycle — une politique configurée par le warrant de ce dépôt.",
    hi: "lifecycle — एक नीति जो इस भंडार के अपने warrant द्वारा विन्यस्त की गई है।",
    id: "lifecycle — kebijakan yang dikonfigurasi oleh warrant milik repositori ini.",
    it: "lifecycle — una policy configurata dal warrant di questo repository.",
    ja: "lifecycle — このリポジトリのwarrantが設定したポリシーです。",
    ko: "lifecycle — 이 저장소의 warrant가 구성한 정책입니다.",
    nl: "lifecycle — een beleid geconfigureerd door de warrant van deze repository.",
    pl: "lifecycle — zasada skonfigurowana przez warrant należący do tego repozytorium.",
    pt: "lifecycle — uma política configurada pelo warrant deste repositório.",
    ru: "lifecycle — политика, которую настроил warrant данного репозитория.",
    sv: "lifecycle — en policy som konfigurerats av detta repositories egna warrant.",
    th: "lifecycle — นโยบายที่กำหนดค่าโดย warrant ของที่เก็บนี้เอง",
    tr: "lifecycle — bu deponun kendi warrant tarafından yapılandırılmış bir ilke.",
    uk: "lifecycle — політика, яку налаштував warrant цього репозиторію.",
    vi: "lifecycle — một chính sách do warrant của repository này cấu hình.",
    zh: "lifecycle — 该仓库自己的 warrant 所配置的策略。",
  },

  // respond/publish.ts — one reply, one language throughout, via `chrome`.
  respondBoundaryDrafted: {
    en: "This reply was drafted by [Reeve](https://github.com/ecoma-io/reeve), not by a maintainer.",
    ar: "صيغ هذا الرد بواسطة [Reeve](https://github.com/ecoma-io/reeve)، وليس بواسطة مشرف.",
    cs: "Tato odpověď byla vytvořena [Reeve](https://github.com/ecoma-io/reeve), nikoliv správcem.",
    de: "Diese Antwort wurde von [Reeve](https://github.com/ecoma-io/reeve) verfasst, nicht von einem Maintainer.",
    es: "Esta respuesta fue redactada por [Reeve](https://github.com/ecoma-io/reeve), no por un mantenedor.",
    fr: "Cette réponse a été rédigée par [Reeve](https://github.com/ecoma-io/reeve), et non par un responsable.",
    hi: "यह उत्तर [Reeve](https://github.com/ecoma-io/reeve) द्वारा तैयार किया गया था, किसी अनुरक्षक द्वारा नहीं।",
    id: "Balasan ini disusun oleh [Reeve](https://github.com/ecoma-io/reeve), bukan oleh pengelola.",
    it: "Questa risposta è stata redatta da [Reeve](https://github.com/ecoma-io/reeve), non da un manutentore.",
    ja: "この返信はメンテナーではなく、[Reeve](https://github.com/ecoma-io/reeve)によって作成されました。",
    ko: "이 답글은 유지자가 아닌 [Reeve](https://github.com/ecoma-io/reeve)가 작성했습니다.",
    nl: "Dit antwoord is opgesteld door [Reeve](https://github.com/ecoma-io/reeve), niet door een beheerder.",
    pl: "Ta odpowiedź została przygotowana przez [Reeve](https://github.com/ecoma-io/reeve), a nie przez opiekuna.",
    pt: "Esta resposta foi redigida por [Reeve](https://github.com/ecoma-io/reeve), e não por um mantenedor.",
    ru: "Этот ответ составлен [Reeve](https://github.com/ecoma-io/reeve), а не сопровождающим.",
    sv: "Detta svar utarbetades av [Reeve](https://github.com/ecoma-io/reeve), inte av en underhållare.",
    th: "การตอบกลับนี้ร่างโดย [Reeve](https://github.com/ecoma-io/reeve) ไม่ใช่โดยผู้ดูแล",
    tr: "Bu yanıt [Reeve](https://github.com/ecoma-io/reeve) tarafından hazırlanmıştır, bir bakıcı tarafından değil.",
    uk: "Ця відповідь складена [Reeve](https://github.com/ecoma-io/reeve), а не супровідником.",
    vi: "Phản hồi này do [Reeve](https://github.com/ecoma-io/reeve) soạn, không phải do maintainer viết.",
    zh: "此回复由 [Reeve](https://github.com/ecoma-io/reeve) 撰写，而非维护者本人。",
  },
  respondBoundaryCaveat: {
    en: "A maintainer has not reviewed it. Treat it as a starting point, not an answer.",
    ar: "لم يراجعه مشرف. تعامله كنقطة بداية، وليس كإجابة.",
    cs: "Nebyla zkontrolována správcem. Považujte ji za výchozí bod, nikoliv za odpověď.",
    de: "Ein Maintainer hat sie nicht überprüft. Behandeln Sie sie als Ausgangspunkt, nicht als Antwort.",
    es: "Un mantenedor no la ha revisado. Trátela como un punto de partida, no como una respuesta.",
    fr: "Un responsable ne l'a pas examinée. Considérez-la comme un point de départ, et non comme une réponse.",
    hi: "किसी अनुरक्षक ने इसकी समीक्षा नहीं की है। इसे उत्तर न मानें, वरन् एक आरंभ बिंदु के रूप में उपयोग करें।",
    id: "Belum ditinjau oleh pengelola. Perlakukan sebagai titik awal, bukan jawaban.",
    it: "Un manutentore non l'ha revisionata. La consideri come punto di partenza, non come risposta.",
    ja: "メンテナーによるレビューは行われていません。回答ではなく、出発点として扱ってください。",
    ko: "유지자가 검토하지 않았습니다. 답이 아닌 시작점으로 간주하십시오.",
    nl: "Een beheerder heeft dit niet beoordeeld. Beschouw het als een vertrekpunt, niet als een antwoord.",
    pl: "Nie została sprawdzona przez opiekuna. Traktuj ją jako punkt wyjścia, a nie jako ostateczną odpowiedź.",
    pt: "Um mantenedor não a revisou. Trate-a como um ponto de partida, não como uma resposta.",
    ru: "Сопровождающий не проверял его. Используйте как отправную точку, а не как окончательный ответ.",
    sv: "Det har inte granskats av en underhållare. Behandla det som en utgångspunkt, inte som ett svar.",
    th: "ผู้ดูแลยังไม่ได้ตรวจสอบ โปรดถือเป็นจุดเริ่มต้น ไม่ใช่คำตอบ",
    tr: "Bir bakıcı tarafından incelenmemiştir. Bir yanıt olarak değil, bir başlangıç noktası olarak değerlendirin.",
    uk: "Супровідник не перевіряв її. Використовуйте як відправну точку, а не як остаточну відповідь.",
    vi: "Chưa có maintainer nào xem xét phản hồi này. Hãy xem đây là điểm khởi đầu, không phải một câu trả lời.",
    zh: "尚无维护者审阅过此回复。请将其视为一个起点，而非最终答案。",
  },
  respondFooterUnknown: {
    en: "This project could not identify the thread's language, so the reply above is in English.",
    ar: "لم يتمكن هذا المشروع من تحديد لغة النقاش، لذا الرد أعلاه بالإنجليزية.",
    cs: "Projekt nedokázal rozpoznat jazyk tohoto vlákna, proto je odpověď výše v angličtině.",
    de: "Dieses Projekt konnte die Sprache des Threads nicht ermitteln, daher ist die obige Antwort auf Englisch.",
    es: "Este proyecto no pudo identificar el idioma del hilo, por lo que la respuesta anterior está en inglés.",
    fr: "Ce projet n'a pas pu identifier la langue du fil, la réponse ci-dessus est donc en anglais.",
    hi: "इस परियोजना ने थ्रेड की भाषा पहचान नहीं कर पाया, इसलिए ऊपर का उत्तर अंग्रेज़ी में है।",
    id: "Proyek ini tidak dapat mengidentifikasi bahasa utas, sehingga balasan di atas ditulis dalam bahasa Inggris.",
    it: "Questo progetto non ha potuto identificare la lingua della discussione, quindi la risposta sopra è in inglese.",
    ja: "スレッドの言語を特定できなかったため、上の返信は英語で作成されています。",
    ko: "스레드의 언어를 식별할 수 없어, 위 답글은 영어로 작성되었습니다.",
    nl: "Dit project kon de taal van de thread niet identificeren, daarom is het bovenstaande antwoord in het Engels.",
    pl: "Projekt nie potrafił rozpoznać języka tego wątku, dlatego powyższa odpowiedź jest w języku angielskim.",
    pt: "Este projeto não conseguiu identificar o idioma do tópico, portanto a resposta acima está em inglês.",
    ru: "Проекту не удалось определить язык потока, поэтому ответ выше составлен на английском.",
    sv: "Projektet kunde inte identifiera trådens språk, så svaret ovan är på engelska.",
    th: "โปรเจกต์นี้ไม่สามารถระบุภาษาของเธรดได้ ดังนั้นการตอบกลับด้านบนจึงเป็นภาษาอังกฤษ",
    tr: "Bu proje iş parçacığının dilini belirleyemedi, bu nedenle yukarıdaki yanıt İngilizcedir.",
    uk: "Проекту не вдалося визначити мову потоку, тому відповідь вище складена англійською.",
    vi: "Dự án này không thể xác định ngôn ngữ của chủ đề, vì vậy phản hồi phía trên bằng tiếng Anh.",
    zh: "本项目无法识别该话题所使用的语言，因此上面的回复使用英文。",
  },
  respondFooterKnown: {
    en: "The thread was written in {label}.",
    ar: "كُتب النقاش بـ{label}.",
    cs: "Vlákno bylo napsáno v jazyce {label}.",
    de: "Der Thread wurde in {label} verfasst.",
    es: "El hilo fue escrito en {label}.",
    fr: "Le fil a été rédigé en {label}.",
    hi: "यह थ्रेड {label} में लिखा गया था।",
    id: "Utas ini ditulis dalam {label}.",
    it: "La discussione è stata scritta in {label}.",
    ja: "スレッドの作成言語は{label}です。",
    ko: "스레드의 작성 언어는 {label}입니다.",
    nl: "De thread is geschreven in {label}.",
    pl: "Wątek został napisany w języku {label}.",
    pt: "O tópico foi escrito em {label}.",
    ru: "Язык потока: {label}.",
    sv: "Tråden skrevs på {label}.",
    th: "เธรดนี้เขียนด้วย {label}",
    tr: "İş parçacığı {label} dilinde yazılmıştır.",
    uk: "Мова потоку: {label}.",
    vi: "Chủ đề này được viết bằng {label}.",
    zh: "该话题使用{label}撰写。",
  },
  respondFooterRecord: {
    en: "Reeve answers a thread once. This comment is the record of it.",
    ar: "يُجيب Reeve عن النقاش مرة واحدة. هذا التعليق هو سجلّ ذلك.",
    cs: "Reeve odpovídá ve vlákně pouze jednou. Tento komentář je záznamem o tom.",
    de: "Reeve antwortet in einem Thread nur einmal. Dieser Kommentar ist der Nachweis dafür.",
    es: "Reeve responde a un hilo una sola vez. Este comentario es el registro de ello.",
    fr: "Reeve ne répond qu'une seule fois à un fil. Ce commentaire en constitue le registre.",
    hi: "Reeve एक थ्रेड का केवल एक बार उत्तर देता है। यह टिप्पणी उसका अभिलेख है।",
    id: "Reeve hanya menjawab suatu utas satu kali. Komentar ini adalah catatannya.",
    it: "Reeve risponde a una discussione una sola volta. Questo commento ne è il resoconto.",
    ja: "Reeveはスレッドにつき1回のみ回答します。このコメントがその記録です。",
    ko: "Reeve는 스레드당 한 번만 답변합니다. 이 댓글이 그 기록입니다.",
    nl: "Reeve beantwoordt een thread slechts eenmaal. Dit commentaar is het verslag daarvan.",
    pl: "Reeve odpowiada w wątku tylko raz. Ten komentarz jest tego zapisem.",
    pt: "Reeve responde a um tópico apenas uma vez. Este comentário é o registro disso.",
    ru: "Reeve отвечает на поток один раз. Этот комментарий — запись об этом.",
    sv: "Reeve svarar i en tråd en gång. Denna kommentar är protokollet över det.",
    th: "Reeve ตอบเธรดหนึ่งครั้งเท่านั้น ความคิดเห็นนี้คือบันทึกของการตอบนั้น",
    tr: "Reeve bir iş parçacığını yalnızca bir kez yanıtlar. Bu yorum bunun kaydıdır.",
    uk: "Reeve відповідає на потік один раз. Цей коментар — запис про це.",
    vi: "Reeve chỉ trả lời mỗi chủ đề một lần. Bình luận này chính là bản ghi của lần trả lời đó.",
    zh: "Reeve 只回答一个话题一次。此评论就是这次回答的记录。",
  },

  // duplicate/publish.ts — one proposal, one language (the thread's own —
  // see `render`'s doc comment for why that signal is trustworthy here even
  // though ranking may bridge through a pivot language to find it), via
  // `chrome`.
  duplicatePossible: {
    en: "Possible duplicate of #{number}.",
    ar: "تكرار محتمل لـ#{number}.",
    cs: "Možný duplikát #{number}.",
    de: "Mögliches Duplikat von #{number}.",
    es: "Posible duplicado de #{number}.",
    fr: "Possible doublon de #{number}.",
    hi: "#{number} का संभावित प्रतिरूप।",
    id: "Kemungkinan duplikat dari #{number}.",
    it: "Possibile duplicato di #{number}.",
    ja: "#{number}の重複の可能性があります。",
    ko: "#{number}의 중복 가능성이 있습니다.",
    nl: "Mogelijk duplicaat van #{number}.",
    pl: "Możliwy duplikat #{number}.",
    pt: "Possível duplicata de #{number}.",
    ru: "Возможный дубликат #{number}.",
    sv: "Möjlig dubblett av #{number}.",
    th: "อาจเป็นรายการซ้ำของ #{number}",
    tr: "#{number} numaralı konunun olası kopyası.",
    uk: "Можливий дублікат #{number}.",
    vi: "Có thể trùng lặp với #{number}.",
    zh: "可能与 #{number} 重复。",
  },
  duplicateFooterFloor: {
    en: "Proposed by a model, not decided by a maintainer — read it as a lead to check.",
    ar: "اقترحه نموذج، ولم يقرره مشرف — تعامله كمؤشر للتحقق.",
    cs: "Navrženo modelem, nikoliv rozhodnuto správcem — chápejte jako podnět k prověření.",
    de: "Von einem Modell vorgeschlagen, nicht von einem Maintainer entschieden — als Hinweis betrachten, der geprüft werden sollte.",
    es: "Propuesto por un modelo, no decidido por un mantenedor — léalo como una pista para verificar.",
    fr: "Proposé par un modèle, et non décidé par un responsable — à considérer comme une piste à vérifier.",
    hi: "किसी मॉडल द्वारा प्रस्तावित, किसी अनुरक्षक द्वारा निर्णीत नहीं — इसे जाँचने का संकेत मानें।",
    id: "Diusulkan oleh model, bukan diputuskan oleh pengelola — gunakan sebagai petunjuk untuk diperiksa.",
    it: "Proposto da un modello, non deciso da un manutentore — da considerarsi come un indizio da verificare.",
    ja: "モデルによる提案であり、メンテナーによる決定ではありません。確認の手がかりとして扱ってください。",
    ko: "모델이 제안한 것으로, 유지자가 결정하지 않았습니다 — 확인할 참고 자료로 활용하십시오.",
    nl: "Voorgesteld door een model, niet beslist door een beheerder — lees het als een aanwijzing om te controleren.",
    pl: "Zaproponowane przez model, a nie ustalone przez opiekuna — traktuj jako wskazówkę do sprawdzenia.",
    pt: "Proposto por um modelo, não decidido por um mantenedor — trate como um indício a verificar.",
    ru: "Предложено моделью, а не определено сопровождающим — используйте как повод для проверки.",
    sv: "Föreslaget av en modell, inte beslutat av en underhållare — läs det som en ledtråd att undersöka.",
    th: "เสนอโดยโมเดล ไม่ใช่การตัดสินโดยผู้ดูแล — โปรดใช้เป็นเบาะแสสำหรับตรวจสอบ",
    tr: "Bir model tarafından önerilmiş, bir bakıcı tarafından kararlaştırılmamıştır — inceleme ipucu olarak değerlendirin.",
    uk: "Запропоновано моделлю, а не визначено супровідником — сприймайте як підказку для перевірки.",
    vi: "Do một model đề xuất, không phải quyết định của maintainer — hãy xem đây là một gợi ý cần kiểm chứng.",
    zh: "由模型提出，而非维护者的决定 — 请将其视为需要核实的线索。",
  },
  duplicateFooterEditable: {
    en: "Editing this thread and re-running replaces this comment; it is never posted twice.",
    ar: "تعديل هذا النقاش وإعادة التشغيل يستبدل هذا التعليق؛ ولا يُنشر مرتين.",
    cs: "Úprava tohoto vlákna a opětovné spuštění nahradí tento komentář; nebude publikován dvakrát.",
    de: "Das Bearbeiten dieses Threads und erneute Ausführen ersetzt diesen Kommentar; er wird nie zweimal veröffentlicht.",
    es: "Editar este hilo y volver a ejecutar reemplaza este comentario; nunca se publica dos veces.",
    fr: "Modifier ce fil et relancer remplacera ce commentaire ; il n'est jamais publié deux fois.",
    hi: "इस थ्रेड को संपादित करके पुनः चलाने से यह टिप्पणी बदल जाती है; यह कभी दो बार पोस्ट नहीं किया जाता।",
    id: "Menyunting utas ini dan menjalankan ulang akan mengganti komentar ini; tidak akan diposting dua kali.",
    it: "La modifica di questa discussione e una nuova esecuzione sostituiscono questo commento; non viene mai pubblicato due volte.",
    ja: "このスレッドを編集して再実行すると、このコメントが置き換えられます。二重投稿されることはありません。",
    ko: "이 스레드를 편집하고 다시 실행하면 이 댓글이 교체됩니다. 중복 게시되지 않습니다.",
    nl: "Deze thread bewerken en opnieuw uitvoeren vervangt dit commentaar; het wordt nooit twee keer geplaatst.",
    pl: "Edycja tego wątku i ponowne uruchomienie zastępuje ten komentarz; nie jest publikowany dwukrotnie.",
    pt: "Editar este tópico e executar novamente substitui este comentário; ele nunca é publicado duas vezes.",
    ru: "Редактирование этого потока и повторный запуск заменят этот комментарий; он никогда не публикуется дважды.",
    sv: "Att redigera denna tråd och köra igen ersätter denna kommentar; den postas aldrig två gånger.",
    th: "การแก้ไขเธรดนี้และเรียกใช้ใหม่จะแทนที่ความคิดเห็นนี้ จะไม่มีการโพสต์ซ้ำ",
    tr: "Bu iş parçacığını düzenleyip yeniden çalıştırmak bu yorumu değiştirir; iki kez gönderilmez.",
    uk: "Редагування цього потоку та повторний запуск замінять цей коментар; він ніколи не публікується двічі.",
    vi: "Chỉnh sửa chủ đề này và chạy lại sẽ thay thế bình luận này; nó không bao giờ được đăng hai lần.",
    zh: "编辑此话题并重新运行会替换此评论；它绝不会被发布两次。",
  },

  // review/publish.ts — one review comment per pull request, the thread's own
  // language when detection found one, English otherwise, via `chrome`.
  reviewEmpty: {
    en: "No issues to report — this review found nothing worth flagging.",
    ar: "لا توجد مشكلات للإبلاغ عنها — لا شيء يستدعي التنبيه في هذه المراجعة.",
    cs: "Žádné problémy k hlášení — tato recenze nenašla nic, co by stálo za upozornění.",
    de: "Keine Probleme zu melden — diese Überprüfung hat nichts gefunden, das eine Erwähnung wert wäre.",
    es: "Nada que informar: esta revisión no encontró nada que valga la pena señalar.",
    fr: "Rien à signaler — cette revue n'a rien trouvé qui mérite d'être signalé.",
    hi: "रिपोर्ट करने के लिए कुछ नहीं — इस समीक्षा में कुछ भी ध्यान देने योग्य नहीं मिला।",
    id: "Tidak ada masalah untuk dilaporkan — ulasan ini tidak menemukan hal yang perlu ditandai.",
    it: "Nessun problema da segnalare — questa revisione non ha trovato nulla degno di nota.",
    ja: "報告する問題はありません — このレビューで指摘するものは見つかりませんでした。",
    ko: "보고할 문제가 없습니다 — 이 검토에서 지적할 만한 것을 찾지 못했습니다.",
    nl: "Niets te melden — deze review vond niets dat de moeite van het noemen waard is.",
    pl: "Brak problemów do zgłoszenia — ten przegląd nie znalazł niczego wartego uwagi.",
    pt: "Nada a relatar — esta revisão não encontrou nada digno de nota.",
    ru: "Нечего сообщить — этот обзор не нашёл ничего, что стоит отметить.",
    sv: "Ingenting att rapportera — denna granskning hittade inget värt att flagga.",
    th: "ไม่มีปัญหาที่ต้องรายงาน — การตรวจทานนี้ไม่พบสิ่งที่ควรชี้ให้เห็น",
    tr: "Bildirilecek bir sorun yok — bu inceleme işaret etmeye değer bir şey bulmadı.",
    uk: "Немає проблем для звітування — цей огляд не знайшов нічого вартого уваги.",
    vi: "Không có vấn đề nào cần báo cáo — buổi rà soát này không tìm thấy gì đáng nêu.",
    zh: "没有需要报告的问题 — 本次审查没有发现值得指出的内容。",
  },
  reviewFooterFloor: {
    en: "This review was written by a model, not decided by a maintainer — read each finding as a lead to check.",
    ar: "كتب هذه المراجعة نموذج، ولم يكتبها مشرف — تعامل مع كل ملاحظة كمؤشر للتحقق.",
    cs: "Tuto recenzi napsal model, nikoliv správce — chápejte každý nález jako podnět k prověření.",
    de: "Diese Überprüfung wurde von einem Modell geschrieben, nicht von einem Maintainer entschieden — jeden Befund als Hinweis zum Prüfen lesen.",
    es: "Esta revisión la escribió un modelo, no la decidió un mantenedor — lea cada hallazgo como una pista para verificar.",
    fr: "Cette revue a été écrite par un modèle, et non décidée par un responsable — à considérer comme une piste à vérifier.",
    hi: "यह समीक्षा किसी मॉडल ने लिखी, किसी अनुरक्षक ने नहीं — हर निष्कर्ष को जाँच के संकेत के रूप में देखें।",
    id: "Ulasan ini ditulis oleh model, bukan diputuskan oleh pengelola — baca setiap temuan sebagai petunjuk untuk diperiksa.",
    it: "Questa revisione è stata scritta da un modello, non decisa da un manutentore — da considerare ogni osservazione come un indizio da verificare.",
    ja: "このレビューはモデルが書いたもので、メンテナーによる決定ではありません。各指摘を確認すべき手がかりとしてください。",
    ko: "이 검토는 모델이 작성했으며, 유지자가 결정하지 않았습니다 — 각 발견을 확인할 참고 자료로 읽으십시오.",
    nl: "Deze review is door een model geschreven, niet door een beheerder beslist — lees elke bevinding als een aanwijzing om te controleren.",
    pl: "Tę recenzję napisał model, a nie opiekun — traktuj każdy wynik jako wskazówkę do sprawdzenia.",
    pt: "Esta revisão foi escrita por um modelo, não decidida por um mantenedor — trate cada constatação como um indício a verificar.",
    ru: "Этот обзор написан моделью, а не сопровождающим — относитесь к каждой находке как к поводу для проверки.",
    sv: "Denna granskning skrevs av en modell, inte av en underhållare — läs varje fynd som en ledtråd att undersöka.",
    th: "การตรวจทานนี้เขียนโดยโมเดล ไม่ใช่การตัดสินโดยผู้ดูแล — โปรดอ่านแต่ละข้อค้นพบเป็นเบาะแสสำหรับตรวจสอบ",
    tr: "Bu inceleme bir model tarafından yazıldı, bir bakıcı tarafından kararlaştırılmadı — her bulguyu inceleme ipucu olarak okuyun.",
    uk: "Цей огляд написано моделлю, а не визначено супровідником — сприймайте кожну знахідку як підказку для перевірки.",
    vi: "Bản rà soát này do một model viết, không phải quyết định của maintainer — hãy xem từng phát hiện như một gợi ý cần kiểm chứng.",
    zh: "此审查由模型编写，而非维护者的决定 — 请将每条发现视为需要核实的线索。",
  },
  reviewFooterEditable: {
    en: "Editing the pull request and re-running replaces this review comment; it is never posted twice.",
    ar: "تعديل طلب السحب وإعادة التشغيل يستبدل تعليق المراجعة هذا؛ ولا يُنشر مرتين.",
    cs: "Úprava pull requestu a opětovné spuštění nahradí tento komentář recenze; nebude publikován dvakrát.",
    de: "Das Bearbeiten des Pull-Requests und erneutes Ausführen ersetzt diesen Review-Kommentar; er wird nie zweimal veröffentlicht.",
    es: "Editar el pull request y volver a ejecutar reemplaza este comentario de revisión; nunca se publica dos veces.",
    fr: "Modifier la pull request et relancer remplacera ce commentaire de revue ; il n'est jamais publié deux fois.",
    hi: "पुल रिक्वेस्ट को संपादित करके पुनः चलाने से यह समीक्षा टिप्पणी बदल जाती है; यह कभी दो बार पोस्ट नहीं होती।",
    id: "Menyunting pull request dan menjalankan ulang akan mengganti komentar ulasan ini; tidak akan diposting dua kali.",
    it: "La modifica della pull request e una nuova esecuzione sostituiscono questo commento di revisione; non viene mai pubblicato due volte.",
    ja: "プルリクエストを編集して再実行すると、このレビューコメントが置き換えられます。二重投稿されることはありません。",
    ko: "풀 리퀘스트를 편집하고 다시 실행하면 이 검토 댓글이 교체됩니다. 중복 게시되지 않습니다.",
    nl: "Deze pull request bewerken en opnieuw uitvoeren vervangt dit review-commentaar; het wordt nooit twee keer geplaatst.",
    pl: "Edycja pull requesta i ponowne uruchomienie zastępuje ten komentarz recenzji; nie jest publikowany dwukrotnie.",
    pt: "Editar o pull request e executar novamente substitui este comentário de revisão; ele nunca é publicado duas vezes.",
    ru: "Редактирование pull request и повторный запуск заменят этот комментарий обзора; он никогда не публикуется дважды.",
    sv: "Att redigera pull requesten och köra igen ersätter denna granskningskommentar; den postas aldrig två gånger.",
    th: "การแก้ไข pull request แล้วเรียกใช้ใหม่จะแทนที่ความคิดเห็นการตรวจทานนี้ จะไม่มีการโพสต์ซ้ำ",
    tr: "Pull request'i düzenleyip yeniden çalıştırmak bu inceleme yorumunu değiştirir; iki kez gönderilmez.",
    uk: "Редагування pull request та повторний запуск замінять цей коментар огляду; він ніколи не публікується двічі.",
    vi: "Chỉnh sửa pull request và chạy lại sẽ thay thế bình luận rà soát này; nó không bao giờ được đăng hai lần.",
    zh: "编辑拉取请求并重新运行会替换此审查评论；它绝不会被发布两次。",
  },
} satisfies Record<string, Row>;

/** Every key {@link CHROME} carries a row for. */
export type ChromeKey = keyof typeof CHROME;

/** Every key {@link CHROME} carries a row for, as a plain array — `chrome.test.ts`'s own key list. */
export const CHROME_KEYS: readonly ChromeKey[] = Object.keys(CHROME) as ChromeKey[];

const LANGUAGE_SET: ReadonlySet<string> = new Set(CHROME_LANGUAGES);

function resolve(code: string | null): ChromeLanguage {
  return code !== null && LANGUAGE_SET.has(code) ? (code as ChromeLanguage) : "en";
}

/**
 * Whether `code` has its own row in this table — the one fact a caller needs
 * to decide whether rendering it fell back to English, for the "noted once"
 * rule: a repository configured for a language chrome does not cover yet
 * gets told so once, in its own job summary, rather than silently reading
 * English scaffolding around content in its own language forever.
 */
export function chromeSupports(code: string | null): boolean {
  return code !== null && LANGUAGE_SET.has(code);
}

function fill(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    if (!Object.hasOwn(params, name)) {
      // A key with a placeholder no caller filled is a bug in this file or
      // its caller, not a malformed run — same posture as an unparseable
      // model answer elsewhere in this project: fail loudly rather than
      // publish the literal `{name}` a reader would have no way to read.
      throw new Error(`chrome: "${whole}" in a template with no "${name}" in params`);
    }
    return params[name] ?? "";
  });
}

/**
 * One chrome string, in the language `code` resolves to — English
 * deterministically when `code` is `null` or not one of
 * {@link CHROME_LANGUAGES}. The single-block case: everything the caller
 * renders under this call already belongs to one language, the same one
 * `code` names.
 */
export function chrome(
  key: ChromeKey,
  code: string | null,
  params: Readonly<Record<string, string>> = {},
): string {
  return fill(CHROME[key][resolve(code)], params);
}

/**
 * The "noted once" half of the fallback rule: a run whose chrome fell back to
 * English because a configured language has no row in this table yet gets
 * one sentence about it in the job summary — never a silent substitution, and
 * never one line per chrome string that happened to fall back the same way.
 *
 * A caller passes every language code its own chrome calls actually used this
 * run — a `Translated`'s posted codes, a `Responded`'s `languageCode`, an
 * `outcome.language` — and gets back `null` when every one of them either has
 * a row here or was already `null` (English is not a fallback from English,
 * it is the language itself). This is deliberately a pure function of the
 * codes a caller already computed rather than a second traversal of any
 * duty's own data — the codes chrome was actually keyed by are the only
 * question this answers.
 */
export function chromeFallbackNote(codes: readonly (string | null)[]): string | null {
  const missing = new Set(
    codes.filter((code): code is string => code !== null && !chromeSupports(code)),
  );
  if (missing.size === 0) return null;

  const list = [...missing]
    .sort()
    .map((code) => `\`${code}\``)
    .join(", ");
  return (
    `${list} — Reeve's own scaffolding text has no translation for ` +
    `${missing.size === 1 ? "this language" : "these languages"} yet, so it rendered in English ` +
    `instead. Chrome covers: ${CHROME_LANGUAGES.join(", ")}.`
  );
}
