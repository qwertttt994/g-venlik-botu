const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Kullaniciyi yasaklar, vaka olusturur ve kara listeye ekler.')
    .addUserOption((o) => o.setName('kullanici').setDescription('Yasaklanacak kullanici').setRequired(true))
    .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(false))
    .addBooleanOption((o) => o.setName('ip_ban').setDescription('IP/Ag izolasyon kaydi da eklensin mi?').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('ip-ban')
    .setDescription('Kullanici veya ag etiketi icin IP/Ag izolasyonu uygular ve yasaklar (Yalnizca Sunucu Sahibi).')
    .addStringOption((o) => o.setName('hedef').setDescription('Kullanici ID veya Ag etiketi').setRequired(true))
    .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('ip-unban')
    .setDescription('IP/Ag izolasyon kaydini kaldirir (Yalnizca Sunucu Sahibi).')
    .addStringOption((o) => o.setName('hedef').setDescription('Kullanici ID veya Ag etiketi').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('Kara listedeki yasagi kaldirir (Yalnizca Sunucu Sahibi).')
    .addStringOption((o) => o.setName('kullanici_id').setDescription('Kullanici ID').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('karaliste')
    .setDescription('Kara liste islemlerini yonetir.')
    .addSubcommand((s) =>
      s
        .setName('ekle')
        .setDescription('Kara listeye ekler ve yasaklar.')
        .addStringOption((o) => o.setName('kullanici_id').setDescription('Kullanici ID').setRequired(true))
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(false))
    )
    .addSubcommand((s) =>
      s
        .setName('cikar')
        .setDescription('Kara listeden cikarir (Yalnizca Sunucu Sahibi).')
        .addStringOption((o) => o.setName('kullanici_id').setDescription('Kullanici ID').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('sorgu')
        .setDescription('Kara liste ve risk durumunu sorgular.')
        .addStringOption((o) => o.setName('kullanici_id').setDescription('Kullanici ID').setRequired(true))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

  new SlashCommandBuilder()
    .setName('guvenli-liste')
    .setDescription('Guvenli listeyi yonetir (Yalnizca Sunucu Sahibi).')
    .addSubcommand((s) =>
      s
        .setName('ekle')
        .setDescription('Kullanici veya rol ekler.')
        .addStringOption((o) =>
          o
            .setName('tur')
            .setDescription('Tur')
            .setRequired(true)
            .addChoices({ name: 'kullanici', value: 'user' }, { name: 'rol', value: 'role' })
        )
        .addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('cikar')
        .setDescription('Kullanici veya rol cikarir.')
        .addStringOption((o) =>
          o
            .setName('tur')
            .setDescription('Tur')
            .setRequired(true)
            .addChoices({ name: 'kullanici', value: 'user' }, { name: 'rol', value: 'role' })
        )
        .addStringOption((o) => o.setName('id').setDescription('ID').setRequired(true))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Kullaniciyi sunucudan atar ve vaka kaydeder.')
    .addUserOption((o) => o.setName('kullanici').setDescription('Kullanici').setRequired(true))
    .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Sureli susturma uygular (10m, 1h, 1d).')
    .addUserOption((o) => o.setName('kullanici').setDescription('Kullanici').setRequired(true))
    .addStringOption((o) => o.setName('sure').setDescription('Sure (10m, 1h, 1d)').setRequired(true))
    .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('untimeout')
    .setDescription('Susturmayi kaldirir.')
    .addUserOption((o) => o.setName('kullanici').setDescription('Kullanici').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('uyar')
    .setDescription('Resmi uyari verir ve risk puanini gunceller.')
    .addUserOption((o) => o.setName('kullanici').setDescription('Kullanici').setRequired(true))
    .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('sicil')
    .setDescription('Uyari, vaka, risk puanini ve son risk gecmisini goruntuler.')
    .addUserOption((o) => o.setName('kullanici').setDescription('Kullanici').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('vaka-sil')
    .setDescription('Belirtilen vakayi siler (Yalnizca Sunucu Sahibi).')
    .addStringOption((o) => o.setName('vaka_id').setDescription('Ornek: CASE-0001').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('karantina')
    .setDescription('Kullaniciyi karantinaya alir veya cikarir.')
    .addSubcommand((s) =>
      s
        .setName('al')
        .setDescription('Rolleri yedekleyip karantinaya alir.')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanici').setRequired(true))
        .addStringOption((o) => o.setName('sebep').setDescription('Sebep').setRequired(false))
        .addStringOption((o) => o.setName('sure').setDescription('Sure (10m, 1h, 1d)').setRequired(false))
    )
    .addSubcommand((s) =>
      s
        .setName('cikar')
        .setDescription('Karantinadan cikarip rolleri geri yukler.')
        .addUserOption((o) => o.setName('kullanici').setDescription('Kullanici').setRequired(true))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('itiraz')
    .setDescription('Ceza veya karantina icin itiraz kaydi olusturur.')
    .addStringOption((o) => o.setName('sebep').setDescription('Itiraz gerekcesi').setRequired(true)),

  new SlashCommandBuilder()
    .setName('itiraz-yonet')
    .setDescription('Itiraz kaydini onaylar veya reddeder (Yalnizca Sunucu Sahibi).')
    .addStringOption((o) => o.setName('itiraz_id').setDescription('Ornek: APL-0001').setRequired(true))
    .addStringOption((o) =>
      o
        .setName('karar')
        .setDescription('Karar')
        .setRequired(true)
        .addChoices({ name: 'onayla', value: 'APPROVED' }, { name: 'reddet', value: 'REJECTED' })
    )
    .addStringOption((o) => o.setName('not').setDescription('Aciklama notu').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('temizle')
    .setDescription('Kanaldaki son mesajlari siler (1-100).')
    .addIntegerOption((o) =>
      o.setName('adet').setDescription('Adet').setMinValue(1).setMaxValue(100).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('kilit')
    .setDescription('Mevcut kanali kilitler veya acar.')
    .addBooleanOption((o) => o.setName('durum').setDescription('true/false').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('sunucu-kilit')
    .setDescription('Tum metin kanallarini kilitler veya acar (Yalnizca Sunucu Sahibi).')
    .addBooleanOption((o) => o.setName('durum').setDescription('true/false').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('yavas-mod')
    .setDescription('Yavas mod suresini ayarlar (0-21600s).')
    .addIntegerOption((o) =>
      o.setName('saniye').setDescription('Saniye').setMinValue(0).setMaxValue(21600).setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  new SlashCommandBuilder()
    .setName('yedek-al')
    .setDescription('Sunucu yapi ve SQLite yedegi alir (Yalnizca Sunucu Sahibi).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('ayar')
    .setDescription('Canli guvenlik ayarlarini goruntuler veya gunceller (Yalnizca Sunucu Sahibi).')
    .addSubcommand((s) => s.setName('goruntule').setDescription('Mevcut ayarlari gosterir.'))
    .addSubcommand((s) =>
      s
        .setName('antinuke-esik')
        .setDescription('Anti-Nuke esik degerini ayarlar (1-20).')
        .addIntegerOption((o) => o.setName('deger').setDescription('Esik').setMinValue(1).setMaxValue(20).setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('raid-esik')
        .setDescription('Anti-Raid 10sn giris esigini ayarlar (2-50).')
        .addIntegerOption((o) => o.setName('deger').setDescription('Esik').setMinValue(2).setMaxValue(50).setRequired(true))
    )
    .addSubcommand((s) =>
      s
        .setName('automod')
        .setDescription('AutoMod durumunu acar/kapatir.')
        .addBooleanOption((o) => o.setName('aktif').setDescription('true/false').setRequired(true))
    )
    .addSubcommand((s) => s.setName('disa-aktar').setDescription('Canli ayarlari JSON olarak verir.'))
    .addSubcommand((s) =>
      s
        .setName('ice-aktar')
        .setDescription('JSON formatinda ayarlari ice aktarir.')
        .addStringOption((o) => o.setName('json').setDescription('JSON metni').setRequired(true))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('80 basamakli güvenlik ve web dashboard özet panelini açar.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('guvenlik-denetimi')
    .setDescription('Sunucu izin, rol ve koruma sagligini denetler.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('istatistik')
    .setDescription('Vaka dagilimi ve guvenlik analitiklerini gosterir.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('guvenlik-test')
    .setDescription('Guvenlik simülasyonu/test raporunu calistirir (Yalnizca Sunucu Sahibi).')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('yetki-denetimi')
    .setDescription('Kritik yetkili rolleri listeler.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('kullanici-bilgi')
    .setDescription('Kullanici guvenlik ve hesap bilgilerini gosterir.')
    .addUserOption((o) => o.setName('kullanici').setDescription('Kullanici').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

  new SlashCommandBuilder()
    .setName('sistem-durumu')
    .setDescription('Guvenlik sisteminin anlik durumunu gosterir.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

module.exports = { commands };
