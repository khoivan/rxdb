import {
    ensureNotFalsy,
    lastOfArray
} from '../';
import { getDatabase } from './database';
import { AVERAGE_FRONT_END_DEVELOPER_SALARY_BY_COUNTRY } from './salaries';

const dbPromise = getDatabase();

const FORM_VALUE_DOCUMENT_ID = 'premium-price-form-value';
type FormValueDocData = {
    teamSize: number;
    homeCountry: string;
    companyAge: CompanyAge;
};

window.onload = async function () {
    const $homeCountry = ensureNotFalsy(document.getElementById('home-country'));
    const $priceCalculatorForm: HTMLFormElement = ensureNotFalsy(document.getElementById('price-calculator-form')) as any;
    const $priceCalculatorSubmit = ensureNotFalsy(document.getElementById('price-calculator-submit'));

    const $priceCalculatorResult = ensureNotFalsy(document.getElementById('price-calculator-result'));
    const $priceCalculatorResultPerMonth = ensureNotFalsy(document.getElementById('total-per-developer-per-month'));
    const $priceCalculatorResultPerYear = ensureNotFalsy(document.getElementById('total-per-year'));


    AVERAGE_FRONT_END_DEVELOPER_SALARY_BY_COUNTRY
        .sort((a, b) => a.code >= b.code ? 1 : -1)
        .forEach(country => {
            const option = document.createElement('option');

            /**
             * Do not use the country.code as option.value
             * because it would create a broken datalist on
             * iOS safari.
             */
            option.value = country.name;

            option.innerHTML = country.name;
            $homeCountry.appendChild(option);
        });


    const database = await dbPromise;
    const formValueDoc = await database.getLocal<FormValueDocData>(FORM_VALUE_DOCUMENT_ID);
    if (formValueDoc) {
        setToInput('developer-count', formValueDoc._data.data.teamSize);
        setToInput('home-country', formValueDoc._data.data.homeCountry);
        setToInput('company-age', formValueDoc._data.data.companyAge);
    }

    $priceCalculatorSubmit.onclick = async () => {
        (window as any).trigger('calculate_premium_price', 3);

        const isValid = ($priceCalculatorForm as any).reportValidity();
        if (!isValid) {
            console.log('form not valid');
            return;
        }
        const formDataPlain = new FormData($priceCalculatorForm);
        const formData = Object.fromEntries(formDataPlain.entries());

        console.log('formData:');
        console.dir(formData);


        const homeCountry = AVERAGE_FRONT_END_DEVELOPER_SALARY_BY_COUNTRY
            .find(o => o.name.toLowerCase() === (formData['home-country'] as string).toLowerCase());
        if (!homeCountry) {
            return;
        }

        /**
         * Save the input
         * so we have to not re-insert manually on page reload.
         */
        await database.upsertLocal<FormValueDocData>(FORM_VALUE_DOCUMENT_ID, {
            companyAge: formData['company-age'] as any,
            teamSize: formData['developer-count'] as any,
            homeCountry: homeCountry.name
        });

        const packages: string[] = Object.keys(formData)
            .filter(k => k.startsWith('package-'))
            .map(k => lastOfArray(k.split('-')) as any);

        const priceResult = calculatePrice({
            companyAge: formData['company-age'] as any,
            teamSize: formData['developer-count'] as any,
            homeCountryCode: homeCountry.code,
            packages
        });
        console.log('priceResult:');
        console.log(JSON.stringify(priceResult, null, 4));

        const getConverterUrl = (price: number) => {
            return 'https://www.xe.com/en/currencyconverter/convert/?Amount=' + price + '&From=EUR&To=USD';
        };
        const setPrice = (element: typeof $priceCalculatorResultPerMonth, price: number) => {
            element.innerHTML = price + ' &euro; (EUR)';
            (element as any).href = getConverterUrl(price);
        };
        setPrice($priceCalculatorResultPerMonth, priceResult.perDeveloperPerMonth);
        setPrice($priceCalculatorResultPerYear, priceResult.totalPerYear);
        $priceCalculatorResult.style.display = 'block';
    };
};



/**
 * Prices are in percent of average salary.
 */
export const PACKAGE_PRICE: { [k: string]: number; } = {
    browser: 0.49,
    native: 0.65,
    performance: 0.30,
    // source-code access has no base price but only adds x% to the total.
    sourcecode: 0
};

/**
 * @link https://www.statista.com/statistics/256598/global-inflation-rate-compared-to-previous-year/
 */
export const INFLATION_RATE = 0.05;

type CompanyAge = 'more-than-3' | 'less-than-3';

/**
 * All prices are in Euro €
 */
export function calculatePrice(input: {
    teamSize: number;
    homeCountryCode: string;
    companyAge: CompanyAge;
    packages: string[];
}) {

    const baseFee = 400;
    const baseFeePerDeveloper = 90;
    const country = ensureNotFalsy(AVERAGE_FRONT_END_DEVELOPER_SALARY_BY_COUNTRY.find(c => c.code === input.homeCountryCode));
    const developerSalary = country.salary;

    let aimInPercent = 0;
    input.packages.forEach(packageKey => {
        const priceInPercent = PACKAGE_PRICE[packageKey];
        aimInPercent = aimInPercent + priceInPercent;
    });
    console.log('aimInPercent: ' + aimInPercent);

    let totalPerYear = baseFee +
        (baseFeePerDeveloper * input.teamSize) +
        (developerSalary * (aimInPercent / 100) * Math.pow(input.teamSize, 0.6));

    /**
     * Discount for 'young' companies.
     */
    if (input.companyAge === 'less-than-3') {
        totalPerYear = totalPerYear * 0.80;
    }

    /**
     * Discount if more then one package
     */
    if (input.packages.length > 1) {
        totalPerYear = totalPerYear * 0.90;
    }

    /**
     * Add price for source-code read access
     */
    if (input.packages.includes('sourcecode')) {
        totalPerYear = totalPerYear * 1.33;

        /**
         * Providing source code access is complex,
         * so there is a minimum price.
         */
        const minPriceForSourceCodeAccess = 2520;
        if (totalPerYear < minPriceForSourceCodeAccess) {
            totalPerYear = minPriceForSourceCodeAccess;
        }
    }

    /**
     * Respect the inflation rate
     */
    const baseYear = 2022;
    const currentYear = new Date().getFullYear();
    const yearsDiff = currentYear - baseYear;
    const inflationMultiplier = Math.pow((1 + INFLATION_RATE), yearsDiff);
    console.log('inflationMultiplier: ' + inflationMultiplier);
    totalPerYear = totalPerYear * inflationMultiplier;

    totalPerYear = Math.ceil(totalPerYear);
    return {
        totalPerYear,
        perDeveloperPerMonth: Math.floor(totalPerYear / 12 / input.teamSize)
    };
}

function setToInput(name: string, value: any) {
    const element = ensureNotFalsy(document.querySelector('[name=' + name + ']'));
    (element as any).value = value;
}
