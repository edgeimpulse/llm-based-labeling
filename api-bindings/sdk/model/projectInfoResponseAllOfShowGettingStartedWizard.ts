/**
 * Edge Impulse API
 * No description provided (generated by Openapi Generator https://github.com/openapitools/openapi-generator)
 *
 * The version of the OpenAPI document: 1.0.0
 * 
 *
 * NOTE: This class is auto generated by OpenAPI Generator (https://openapi-generator.tech).
 * https://openapi-generator.tech
 * Do not edit the class manually.
 */


export class ProjectInfoResponseAllOfShowGettingStartedWizard {
    'showWizard': boolean;
    /**
    * Current step of the getting started wizard
    */
    'step': number;

    static discriminator: string | undefined = undefined;

    static attributeTypeMap: Array<{name: string, baseName: string, type: string}> = [
        {
            "name": "showWizard",
            "baseName": "showWizard",
            "type": "boolean"
        },
        {
            "name": "step",
            "baseName": "step",
            "type": "number"
        }    ];

    static getAttributeTypeMap() {
        return ProjectInfoResponseAllOfShowGettingStartedWizard.attributeTypeMap;
    }
}

