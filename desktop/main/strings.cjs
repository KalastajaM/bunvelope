const messages = {
  en: {
    view: 'View', help: 'Help', update: 'Check for updates…', title: 'Bunvelope',
    startError: 'Bunvelope could not start',
    cancel: 'Cancel', updateUnavailable: 'Automatic updates are not configured for this build. Install a newer package to upgrade; your budget folders are preserved.',
    upToDate: 'You have the latest version.', download: 'Download update',
    updateFound: 'A new version of Bunvelope is available:', install: 'Install and restart', later: 'Later',
    updateReady: 'The update is ready to install.', updateError: 'The update could not be completed.',
    pending: 'Bunvelope is still saving. Wait for the save to finish, then try again.',
  },
  fi: {
    view: 'Näytä', help: 'Ohje', update: 'Tarkista päivitykset…', title: 'Bunvelope',
    startError: 'Bunvelope ei käynnistynyt',
    cancel: 'Peruuta', updateUnavailable: 'Automaattisia päivityksiä ei ole määritetty tälle versiolle. Päivitä asentamalla uudempi paketti; budjettikansiot säilyvät.',
    upToDate: 'Käytössäsi on uusin versio.', download: 'Lataa päivitys',
    updateFound: 'Uusi Bunvelope-versio on saatavilla:', install: 'Asenna ja käynnistä uudelleen', later: 'Myöhemmin',
    updateReady: 'Päivitys on valmis asennettavaksi.', updateError: 'Päivitystä ei voitu suorittaa.',
    pending: 'Bunvelope tallentaa vielä. Odota tallennuksen päättymistä ja yritä uudelleen.',
  },
  nl: {
    view: 'Weergave', help: 'Help', update: 'Zoeken naar updates…', title: 'Bunvelope',
    startError: 'Bunvelope kon niet starten',
    cancel: 'Annuleren', updateUnavailable: 'Automatische updates zijn niet ingesteld voor deze versie. Installeer een nieuwer pakket om bij te werken; je budgetmappen blijven behouden.',
    upToDate: 'Je hebt de nieuwste versie.', download: 'Update downloaden',
    updateFound: 'Er is een nieuwe versie van Bunvelope beschikbaar:', install: 'Installeren en herstarten', later: 'Later',
    updateReady: 'De update is klaar om te installeren.', updateError: 'De update kon niet worden voltooid.',
    pending: 'Bunvelope is nog aan het opslaan. Wacht tot het opslaan klaar is en probeer het opnieuw.',
  },
};
function strings(locale) { return messages[locale.split('-')[0]] || messages.en; }
module.exports = { strings, messages };
